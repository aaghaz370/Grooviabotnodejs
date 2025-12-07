import 'dotenv/config';
import express from 'express';
import fetch from 'node-fetch';
import { Telegraf, Markup } from 'telegraf';

const BOT_TOKEN = process.env.BOT_TOKEN;
const SAAVN_BASE = process.env.SAAVN_BASE || 'https://jiosavan-sigma.vercel.app';
const ADMIN_ID = process.env.ADMIN_ID ? Number(process.env.ADMIN_ID) : null;

if (!BOT_TOKEN) {
  console.error('BOT_TOKEN missing in .env');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

/* ------------------------------------------------------------------ */
/*  SMALL HELPERS                                                      */
/* ------------------------------------------------------------------ */

const userState = new Map(); // Map<userId, {quality, mode, searchType, query, page, lastResults, history}>
const globalStats = {
  totalRequests: 0,
  totalDownloads: 0,
  users: new Set()
};

// escape markdown v2 (simple version)
function escapeMd(text = '') {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

function secondsToTime(sec = 0) {
  const t = Number(sec) || 0;
  const m = Math.floor(t / 60).toString().padStart(2, '0');
  const s = Math.floor(t % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function getUser(ctx) {
  const id = ctx.from.id;
  if (!userState.has(id)) {
    userState.set(id, {
      quality: '320', // default
      mode: null,
      searchType: null,
      query: null,
      page: 0,
      lastResults: [],
      history: []
    });
  }
  return userState.get(id);
}

function addHistory(ctx, type, item) {
  const u = getUser(ctx);
  u.history.unshift({ type, item, at: Date.now() });
  if (u.history.length > 20) u.history = u.history.slice(0, 20);
}

/* ------------------------------------------------------------------ */
/*  API WRAPPER                                                        */
/* ------------------------------------------------------------------ */

async function callSaavn(endpoint, params = {}) {
  const url = new URL(SAAVN_BASE + endpoint);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  });

  globalStats.totalRequests += 1;

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Saavn API error ${res.status}`);
  const data = await res.json();
  if (!data.success) throw new Error('Saavn API success:false');
  return data.data || data;
}

/* ---------- guessed endpoints: adjust to your docs ---------- */

// search
const Saavn = {
  searchSongs: (q, page = 0, limit = 10) =>
    callSaavn('/api/search/songs', { query: q, page, limit }),
  searchAlbums: (q, page = 0, limit = 10) =>
    callSaavn('/api/search/albums', { query: q, page, limit }),
  searchPlaylists: (q, page = 0, limit = 10) =>
    callSaavn('/api/search/playlists', { query: q, page, limit }),
  searchArtists: (q, page = 0, limit = 10) =>
    callSaavn('/api/search/artists', { query: q, page, limit }),

  // songs
  songById: (id) => callSaavn('/api/songs', { id }),
  songByLink: (link) => callSaavn('/api/songs', { link }),
  songSuggestions: (id) => callSaavn('/api/songs/suggestions', { id }),

  // album
  albumById: (id, page = 0, limit = 50) =>
    callSaavn('/api/albums', { id, page, limit }),
  albumByLink: (link, page = 0, limit = 50) =>
    callSaavn('/api/albums', { link, page, limit }),

  // playlist
  playlistById: (id, page = 0, limit = 50, link) =>
    callSaavn('/api/playlists', { id, link, page, limit }),
  playlistByLink: (link, page = 0, limit = 50) =>
    callSaavn('/api/playlists', { link, page, limit }),

  // artist
  artistById: (id) => callSaavn('/api/artists', { id }),
  artistByLink: (link) => callSaavn('/api/artists', { link }),
  artistSongs: (id, page = 0, limit = 10) =>
    callSaavn('/api/artists/songs', { id, page, limit }),
  artistAlbums: (id, page = 0, limit = 10) =>
    callSaavn('/api/artists/albums', { id, page, limit })
};

/* ------------------------------------------------------------------ */
/*  KEYBOARDS                                                          */
/* ------------------------------------------------------------------ */

const mainKeyboard = Markup.keyboard([
  ['🎵 Search songs', '📀 Search albums'],
  ['📂 Search playlists', '👤 Search artists'],
  ['🔥 Trending', '🕘 History'],
  ['⚙️ Settings']
]).resize();

function settingsKeyboard(currentQuality) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(
        `${currentQuality === '96' ? '✅ ' : ''}🚀 Fast (96kbps)`,
        'q:96'
      )
    ],
    [
      Markup.button.callback(
        `${currentQuality === '160' ? '✅ ' : ''}⚖️ Balanced (160kbps)`,
        'q:160'
      )
    ],
    [
      Markup.button.callback(
        `${currentQuality === '320' ? '✅ ' : ''}🎧 High (320kbps)`,
        'q:320'
      )
    ]
  ]);
}

/* ------------------------------------------------------------------ */
/*  RENDERING HELPERS                                                  */
/* ------------------------------------------------------------------ */

function renderSongLine(s) {
  const title = s.name || 'Unknown';
  const artist =
    s.artists?.primary?.map((a) => a.name).join(', ') ||
    s.primaryArtists ||
    'Unknown';
  const dur = secondsToTime(s.duration);
  return `🎵 ${escapeMd(title)} • ${escapeMd(artist)} • ${dur}`;
}

function renderAlbumLine(a) {
  const title = a.name || a.title || 'Unknown';
  const artist = a.primaryArtists || a.artist || '';
  const count = a.songCount || a.numberOfSongs || a.songs?.length || '?';
  return `📀 ${escapeMd(title)} • ${escapeMd(artist)} • ${count} songs`;
}

function renderPlaylistLine(p) {
  const title = p.name || p.title || 'Unknown';
  const subtitle = p.subtitle || p.artist || '';
  const count = p.songCount || p.numberOfSongs || p.songs?.length || '?';
  return `📂 ${escapeMd(title)} • ${escapeMd(subtitle)} • ${count} songs`;
}

function renderArtistLine(a) {
  const name = a.name || 'Unknown';
  const role = a.role || 'Artist';
  return `👤 ${escapeMd(name)} • ${escapeMd(role)}`;
}

function buildPaginationKeyboard(kind, query, page, totalPages) {
  const buttons = [];
  const base = `page:${kind}|${encodeURIComponent(query)}|`;

  if (page > 0) {
    buttons.push(Markup.button.callback('⬅️ Prev', base + (page - 1)));
  }
  if (page < totalPages - 1) {
    buttons.push(Markup.button.callback('Next ➡️', base + (page + 1)));
  }

  const middle = Markup.button.callback(`Page ${page + 1}/${totalPages}`, 'noop');

  if (buttons.length === 2) {
    return Markup.inlineKeyboard([buttons, [middle]]);
  }
  if (buttons.length === 1) {
    return Markup.inlineKeyboard([[...buttons, middle]]);
  }
  return Markup.inlineKeyboard([[middle]]);
}

/* ------------------------------------------------------------------ */
/*  SONG DETAIL + DOWNLOAD                                            */
/* ------------------------------------------------------------------ */

function chooseDownloadUrl(song, qualityPreference = '320') {
  const arr = song.downloadUrl || song.download_urls || [];
  if (!Array.isArray(arr) || !arr.length) return null;

  const byQuality = (q) =>
    arr.find((d) => d.quality?.startsWith(q) || d.quality === `${q}kbps`);

  const preferred = byQuality(qualityPreference);
  if (preferred) return preferred.url;

  // fallback order
  return (
    byQuality('320')?.url ||
    byQuality('160')?.url ||
    byQuality('96')?.url ||
    arr[arr.length - 1].url
  );
}

async function showSongDetail(ctx, id) {
  const data = await Saavn.songById(id);
  const song = Array.isArray(data) ? data[0] : data.results?.[0] || data;

  if (!song) {
    return ctx.reply('Song not found 😵‍💫');
  }

  addHistory(ctx, 'song', { id: song.id, name: song.name });

  const title = song.name || 'Unknown';
  const artist =
    song.artists?.primary?.map((a) => a.name).join(', ') ||
    song.primaryArtists ||
    'Unknown';
  const albumName = song.album?.name || song.album || '';
  const year = song.year || '';
  const lang = song.language || '';
  const dur = secondsToTime(song.duration);
  const cover =
    song.image?.find((i) => i.quality === '500x500')?.url ||
    song.image?.[song.image.length - 1]?.url;

  const caption =
    `🎵 *${escapeMd(title)}*\n` +
    `👤 ${escapeMd(artist)}\n` +
    (albumName ? `💿 ${escapeMd(albumName)}\n` : '') +
    `⏱ ${dur}` +
    (year ? ` • 🗓 ${year}` : '') +
    (lang ? ` • 🌐 ${escapeMd(lang)}` : '') +
    `\n\n_Use the buttons below to download or explore similar tracks._`;

  const kb = Markup.inlineKeyboard([
    [
      Markup.button.callback('⬇️ Download', `dl:${song.id}`),
      Markup.button.callback('✨ Similar', `similar:${song.id}`)
    ]
  ]);

  if (cover) {
    await ctx.replyWithPhoto(
      { url: cover },
      {
        caption,
        parse_mode: 'MarkdownV2',
        ...kb
      }
    );
  } else {
    await ctx.reply(caption, { parse_mode: 'MarkdownV2', ...kb });
  }
}

async function handleDownloadSong(ctx, id) {
  const u = getUser(ctx);
  const data = await Saavn.songById(id);
  const song = Array.isArray(data) ? data[0] : data.results?.[0] || data;

  if (!song) {
    await ctx.answerCbQuery('Song not found 😢', { show_alert: true });
    return;
  }

  const url = chooseDownloadUrl(song, u.quality);
  if (!url) {
    await ctx.answerCbQuery('Download link missing 😢', { show_alert: true });
    return;
  }

  globalStats.totalDownloads += 1;

  const loader = await ctx.reply('⏳ Fetching high-quality audio for you...');

  const title = song.name || 'Unknown';
  const artist =
    song.artists?.primary?.map((a) => a.name).join(', ') ||
    song.primaryArtists ||
    'Unknown';

  try {
    await ctx.replyWithAudio(
      { url },
      {
        title,
        performer: artist,
        caption:
          `🎵 ${escapeMd(title)}\n👤 ${escapeMd(artist)}\n\nDownloaded via @GrooviaBot`,
        parse_mode: 'MarkdownV2'
      }
    );
    await ctx.deleteMessage(loader.message_id).catch(() => {});
  } catch (e) {
    await ctx.deleteMessage(loader.message_id).catch(() => {});
    await ctx.reply('Telegram ko file bhejte waqt error aaya 😢');
    console.error('Download send error', e);
  }
}

/* ------------------------------------------------------------------ */
/*  SEARCH HANDLERS                                                    */
/* ------------------------------------------------------------------ */

async function performSearch(ctx, type, query, page = 0) {
  const limit = 10;
  const offset = page * limit;
  let res;

  if (!query || !query.trim()) {
    return ctx.reply('Koi naam to likho na 😅');
  }

  if (type === 'song') {
    res = await Saavn.searchSongs(query, page, limit);
  } else if (type === 'album') {
    res = await Saavn.searchAlbums(query, page, limit);
  } else if (type === 'playlist') {
    res = await Saavn.searchPlaylists(query, page, limit);
  } else if (type === 'artist') {
    res = await Saavn.searchArtists(query, page, limit);
  } else {
    return;
  }

  const total = res.total || res.count || res.results?.length || 0;
  const results = res.results || [];
  if (!results.length) {
    return ctx.reply('Kuch nahi mila 😶‍🌫️');
  }

  const totalPages = Math.max(1, Math.ceil(total / limit));

  const lines = results.map((item, i) => {
    const index = offset + i + 1;
    if (type === 'song') return `${index}. ${renderSongLine(item)}`;
    if (type === 'album') return `${index}. ${renderAlbumLine(item)}`;
    if (type === 'playlist') return `${index}. ${renderPlaylistLine(item)}`;
    if (type === 'artist') return `${index}. ${renderArtistLine(item)}`;
    return `${index}. ???`;
  });

  const header =
    type === 'song'
      ? '🎵 *Songs*'
      : type === 'album'
      ? '📀 *Albums*'
      : type === 'playlist'
      ? '📂 *Playlists*'
      : '👤 *Artists*';

  const msg =
    `${header} for _${escapeMd(query)}_\n` +
    `Page ${page + 1}/${totalPages}\n\n` +
    lines.join('\n');

  // click actions
  const rowButtons = results.map((item) => {
    if (type === 'song')
      return Markup.button.callback(
        `▶ ${item.name.slice(0, 16)}`,
        `song:${item.id}`
      );
    if (type === 'album')
      return Markup.button.callback(
        `📀 ${item.name.slice(0, 16)}`,
        `album:${item.id}`
      );
    if (type === 'playlist')
      return Markup.button.callback(
        `📂 ${item.name.slice(0, 16)}`,
        `playlist:${item.id}`
      );
    if (type === 'artist')
      return Markup.button.callback(
        `👤 ${item.name.slice(0, 16)}`,
        `artist:${item.id}`
      );
  });

  const rows = [];
  for (let i = 0; i < rowButtons.length; i += 2) {
    rows.push(rowButtons.slice(i, i + 2));
  }

  const pagination = buildPaginationKeyboard(type, query, page, totalPages);
  const inline = Markup.inlineKeyboard([...rows, ...pagination.reply_markup.inline_keyboard]);

  const u = getUser(ctx);
  u.lastResults = results;
  u.query = query;
  u.page = page;
  u.mode = 'search';
  u.searchType = type;

  await ctx.reply(msg, { parse_mode: 'MarkdownV2', ...inline });
}

/* ------------------------------------------------------------------ */
/*  PLAYLIST / ALBUM DETAIL                                            */
/* ------------------------------------------------------------------ */

async function showPlaylistDetail(ctx, idOrLink) {
  const data = await Saavn.playlistById(idOrLink);
  const pl = data;
  if (!pl || !pl.songs) {
    return ctx.reply('Playlist nahi mili 😢');
  }

  addHistory(ctx, 'playlist', { id: pl.id, name: pl.name });

  const cover =
    pl.image?.find((i) => i.quality === '500x500')?.url ||
    pl.image?.[pl.image.length - 1]?.url;

  const title = pl.name || 'Unknown playlist';
  const subtitle = pl.subtitle || '';
  const count = pl.songs.length;

  const caption =
    `📂 *${escapeMd(title)}*\n` +
    (subtitle ? `${escapeMd(subtitle)}\n` : '') +
    `🎵 ${count} songs\n\nTap any song in the list to download individually, or use "Download all".`;

  const kb = Markup.inlineKeyboard([
    [Markup.button.callback('⬇️ Download all', `pldl:${pl.id}`)]
  ]);

  if (cover) {
    await ctx.replyWithPhoto(
      { url: cover },
      { caption, parse_mode: 'MarkdownV2', ...kb }
    );
  } else {
    await ctx.reply(caption, { parse_mode: 'MarkdownV2', ...kb });
  }

  // list of first 10 songs
  const songs = pl.songs.slice(0, 10);
  const lines = songs.map(
    (s, i) => `${i + 1}. ${renderSongLine(s)}`
  );
  const buttons = songs.map((s) =>
    Markup.button.callback(
      `▶ ${s.name.slice(0, 16)}`,
      `song:${s.id}`
    )
  );
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) {
    rows.push(buttons.slice(i, i + 2));
  }

  await ctx.reply(lines.join('\n'), {
    parse_mode: 'MarkdownV2',
    ...Markup.inlineKeyboard(rows)
  });
}

async function showAlbumDetail(ctx, idOrLink) {
  const data = await Saavn.albumById(idOrLink);
  const album = Array.isArray(data) ? data[0] : data;
  if (!album || !album.songs) {
    return ctx.reply('Album nahi mila 😢');
  }

  addHistory(ctx, 'album', { id: album.id, name: album.name });

  const cover =
    album.image?.find((i) => i.quality === '500x500')?.url ||
    album.image?.[album.image.length - 1]?.url;

  const title = album.name || 'Unknown album';
  const artist = album.primaryArtists || album.artist || '';
  const year = album.year || '';
  const count = album.songs.length;

  const caption =
    `📀 *${escapeMd(title)}*\n` +
    (artist ? `👤 ${escapeMd(artist)}\n` : '') +
    (year ? `🗓 ${year}\n` : '') +
    `🎵 ${count} songs\n\nTap any song to download individually, or use "Download all".`;

  const kb = Markup.inlineKeyboard([
    [Markup.button.callback('⬇️ Download all', `abdl:${album.id}`)]
  ]);

  if (cover) {
    await ctx.replyWithPhoto(
      { url: cover },
      { caption, parse_mode: 'MarkdownV2', ...kb }
    );
  } else {
    await ctx.reply(caption, { parse_mode: 'MarkdownV2', ...kb });
  }

  const songs = album.songs.slice(0, 10);
  const lines = songs.map(
    (s, i) => `${i + 1}. ${renderSongLine(s)}`
  );
  const buttons = songs.map((s) =>
    Markup.button.callback(
      `▶ ${s.name.slice(0, 16)}`,
      `song:${s.id}`
    )
  );
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) {
    rows.push(buttons.slice(i, i + 2));
  }

  await ctx.reply(lines.join('\n'), {
    parse_mode: 'MarkdownV2',
    ...Markup.inlineKeyboard(rows)
  });
}

/* ------------------------------------------------------------------ */
/*  BOT COMMANDS                                                       */
/* ------------------------------------------------------------------ */

bot.start(async (ctx) => {
  globalStats.users.add(ctx.from.id);

  await ctx.reply(
    `Hey ${escapeMd(
      ctx.from.first_name || ''
    )} 👋\n\nMain *Groovia Bot* hoon – JioSaavn se gaane search, explore aur download karne ke liye.\n\n` +
      `• Seedha gaane ka naam type karo – main song search karunga\n` +
      `• Ya neeche menu se songs, albums, playlists, artists search karo\n` +
      `• JioSaavn ka song/album/playlist link bhejoge to direct fetch hoga`,
    { parse_mode: 'MarkdownV2', ...mainKeyboard }
  );
});

bot.help(async (ctx) => {
  await ctx.reply(
    `Quick guide:\n\n` +
      `• "Tum Hi Ho" likho → top 10 songs\n` +
      `• "🎵 Search songs" → song search mode\n` +
      `• "📀 Search albums" → album search mode\n` +
      `• "📂 Search playlists" → playlist search mode\n` +
      `• "👤 Search artists" → artist search mode\n` +
      `• JioSaavn URL paste karo → uska detail directly\n` +
      `• ⚙️ Settings → download quality choose\n`,
    mainKeyboard
  );
});

bot.command('stats', async (ctx) => {
  if (ADMIN_ID && ctx.from.id !== ADMIN_ID) return;
  const msg =
    `📊 *Bot stats*\n` +
    `Users seen: ${globalStats.users.size}\n` +
    `Requests: ${globalStats.totalRequests}\n` +
    `Downloads: ${globalStats.totalDownloads}`;
  await ctx.reply(msg, { parse_mode: 'MarkdownV2' });
});

bot.command('broadcast', async (ctx) => {
  if (!ADMIN_ID || ctx.from.id !== ADMIN_ID) return;
  const text = ctx.message.text.split(' ').slice(1).join(' ');
  if (!text) return ctx.reply('Usage: /broadcast message');
  for (const id of globalStats.users) {
    try {
      await bot.telegram.sendMessage(id, `📢 *Broadcast*\n${text}`, {
        parse_mode: 'MarkdownV2'
      });
    } catch (_) {
      // ignore
    }
  }
  ctx.reply('Broadcast sent.');
});

/* ------------------------------------------------------------------ */
/*  TEXT HANDLER (MAIN BRAIN)                                         */
/* ------------------------------------------------------------------ */

function detectSaavnLink(text) {
  const m = text.match(/https?:\/\/(?:www\.)?jiosaavn\.com\/([^ ?]+)/i);
  if (!m) return null;
  const path = m[1]; // song/... , album/..., featured/...
  if (path.startsWith('song')) return { type: 'song', link: text.trim() };
  if (path.startsWith('album')) return { type: 'album', link: text.trim() };
  if (path.startsWith('featured')) return { type: 'playlist', link: text.trim() };
  if (path.startsWith('artist')) return { type: 'artist', link: text.trim() };
  return null;
}

bot.on('text', async (ctx) => {
  globalStats.users.add(ctx.from.id);
  const text = ctx.message.text.trim();
  const u = getUser(ctx);

  // 1) if it's a Saavn URL
  const linkInfo = detectSaavnLink(text);
  if (linkInfo) {
    if (linkInfo.type === 'song') {
      const data = await Saavn.songByLink(linkInfo.link);
      const song = Array.isArray(data) ? data[0] : data.results?.[0] || data;
      if (!song) return ctx.reply('Song nahi mila 😢');
      return showSongDetail(ctx, song.id);
    }
    if (linkInfo.type === 'album') {
      const data = await Saavn.albumByLink(linkInfo.link);
      const album = Array.isArray(data) ? data[0] : data;
      if (!album) return ctx.reply('Album nahi mila 😢');
      return showAlbumDetail(ctx, album.id);
    }
    if (linkInfo.type === 'playlist') {
      const data = await Saavn.playlistByLink(linkInfo.link);
      const pl = data;
      if (!pl) return ctx.reply('Playlist nahi mila 😢');
      return showPlaylistDetail(ctx, pl.id);
    }
    // artist link – basic info
    if (linkInfo.type === 'artist') {
      const data = await Saavn.artistByLink(linkInfo.link);
      const artist = data;
      if (!artist) return ctx.reply('Artist nahi mila 😢');
      const msg =
        `👤 *${escapeMd(artist.name)}*\n` +
        (artist.subtitle ? `${escapeMd(artist.subtitle)}\n` : '') +
        `Tap "Songs" ya "Albums" se aur explore karo.`;
      const kb = Markup.inlineKeyboard([
        [
          Markup.button.callback('🎵 Songs', `artsongs:${artist.id}`),
          Markup.button.callback('📀 Albums', `artalbums:${artist.id}`)
        ]
      ]);
      return ctx.reply(msg, { parse_mode: 'MarkdownV2', ...kb });
    }
  }

  // 2) menu buttons
  if (text === '🎵 Search songs') {
    u.mode = 'await_query';
    u.searchType = 'song';
    return ctx.reply('Kaunsa song? Naam bhejo 🎵');
  }
  if (text === '📀 Search albums') {
    u.mode = 'await_query';
    u.searchType = 'album';
    return ctx.reply('Album ka naam bhejo 📀');
  }
  if (text === '📂 Search playlists') {
    u.mode = 'await_query';
    u.searchType = 'playlist';
    return ctx.reply('Playlist ka naam bhejo 📂');
  }
  if (text === '👤 Search artists') {
    u.mode = 'await_query';
    u.searchType = 'artist';
    return ctx.reply('Artist ka naam bhejo 👤');
  }
  if (text === '⚙️ Settings') {
    const kb = settingsKeyboard(u.quality);
    return ctx.reply(
      'Download quality choose karo (jitna jyada, utna heavy but better audio):',
      kb
    );
  }
  if (text === '🕘 History') {
    if (!u.history.length) return ctx.reply('Abhi tak koi history nahi hai 🙂');
    const lines = u.history.slice(0, 10).map((h) => {
      const label =
        h.type === 'song'
          ? '🎵'
          : h.type === 'album'
          ? '📀'
          : h.type === 'playlist'
          ? '📂'
          : '👤';
      return `${label} ${escapeMd(h.item.name || '')}`;
    });
    return ctx.reply(lines.join('\n'), { parse_mode: 'MarkdownV2' });
  }
  if (text === '🔥 Trending') {
    // you can pick some known playlist ID for trending
    const trendingId = '110858205'; // example
    return showPlaylistDetail(ctx, trendingId);
  }

  // 3) if we are waiting for a query for some type
  if (u.mode === 'await_query' && u.searchType) {
    return performSearch(ctx, u.searchType, text, 0);
  }

  // 4) default: treat as song search
  return performSearch(ctx, 'song', text, 0);
});

/* ------------------------------------------------------------------ */
/*  CALLBACK HANDLERS (INLINE BUTTONS)                                */
/* ------------------------------------------------------------------ */

bot.action(/^song:(.+)/, async (ctx) => {
  await ctx.answerCbQuery();
  const id = ctx.match[1];
  return showSongDetail(ctx, id);
});

bot.action(/^album:(.+)/, async (ctx) => {
  await ctx.answerCbQuery();
  const id = ctx.match[1];
  return showAlbumDetail(ctx, id);
});

bot.action(/^playlist:(.+)/, async (ctx) => {
  await ctx.answerCbQuery();
  const id = ctx.match[1];
  return showPlaylistDetail(ctx, id);
});

bot.action(/^artsongs:(.+)/, async (ctx) => {
  await ctx.answerCbQuery();
  const id = ctx.match[1];
  const data = await Saavn.artistSongs(id, 0, 10);
  const results = data.results || data.songs || [];
  if (!results.length) return ctx.reply('Koi song nahi mila 😢');

  const lines = results.map((s, i) => `${i + 1}. ${renderSongLine(s)}`);
  const buttons = results.map((s) =>
    Markup.button.callback(`▶ ${s.name.slice(0, 16)}`, `song:${s.id}`)
  );
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) {
    rows.push(buttons.slice(i, i + 2));
  }
  await ctx.reply(lines.join('\n'), {
    parse_mode: 'MarkdownV2',
    ...Markup.inlineKeyboard(rows)
  });
});

bot.action(/^artalbums:(.+)/, async (ctx) => {
  await ctx.answerCbQuery();
  const id = ctx.match[1];
  const data = await Saavn.artistAlbums(id, 0, 10);
  const results = data.results || data.albums || [];
  if (!results.length) return ctx.reply('Koi album nahi mila 😢');

  const lines = results.map((a, i) => `${i + 1}. ${renderAlbumLine(a)}`);
  const buttons = results.map((a) =>
    Markup.button.callback(`📀 ${a.name.slice(0, 16)}`, `album:${a.id}`)
  );
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) {
    rows.push(buttons.slice(i, i + 2));
  }
  await ctx.reply(lines.join('\n'), {
    parse_mode: 'MarkdownV2',
    ...Markup.inlineKeyboard(rows)
  });
});

// pagination
bot.action(/^page:(song|album|playlist|artist)\|([^|]+)\|(\d+)/, async (ctx) => {
  const type = ctx.match[1];
  const query = decodeURIComponent(ctx.match[2]);
  const page = Number(ctx.match[3]);
  await ctx.answerCbQuery();
  return performSearch(ctx, type, query, page);
});

// download
bot.action(/^dl:(.+)/, async (ctx) => {
  await ctx.answerCbQuery('Downloading…');
  const id = ctx.match[1];
  return handleDownloadSong(ctx, id);
});

// download all playlist
bot.action(/^pldl:(.+)/, async (ctx) => {
  await ctx.answerCbQuery('Playlist download start…');
  const id = ctx.match[1];
  const data = await Saavn.playlistById(id);
  const pl = data;
  if (!pl || !pl.songs) return ctx.reply('Playlist not found');
  for (const s of pl.songs) {
    await handleDownloadSong(ctx, s.id);
  }
});

// download all album
bot.action(/^abdl:(.+)/, async (ctx) => {
  await ctx.answerCbQuery('Album download start…');
  const id = ctx.match[1];
  const data = await Saavn.albumById(id);
  const album = Array.isArray(data) ? data[0] : data;
  if (!album || !album.songs) return ctx.reply('Album not found');
  for (const s of album.songs) {
    await handleDownloadSong(ctx, s.id);
  }
});

// similar
bot.action(/^similar:(.+)/, async (ctx) => {
  await ctx.answerCbQuery();
  const id = ctx.match[1];
  const data = await Saavn.songSuggestions(id);
  const results = data.data || data.results || [];
  if (!results.length) return ctx.reply('Similar songs nahi mile 😅');

  const lines = results.slice(0, 10).map((s, i) => `${i + 1}. ${renderSongLine(s)}`);
  const buttons = results.slice(0, 10).map((s) =>
    Markup.button.callback(`▶ ${s.name.slice(0, 16)}`, `song:${s.id}`)
  );
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) {
    rows.push(buttons.slice(i, i + 2));
  }
  await ctx.reply('*Similar tracks*:', {
    parse_mode: 'MarkdownV2',
    ...Markup.inlineKeyboard(rows)
  });
});

// settings quality
bot.action(/^q:(96|160|320)/, async (ctx) => {
  const q = ctx.match[1];
  const u = getUser(ctx);
  u.quality = q;
  await ctx.editMessageReplyMarkup(settingsKeyboard(q).reply_markup);
  await ctx.answerCbQuery(`Quality set to ${q}kbps`);
});

// no-op
bot.action('noop', async (ctx) => {
  await ctx.answerCbQuery();
});

/* ------------------------------------------------------------------ */
/*  START BOT + EXPRESS SERVER                                        */
/* ------------------------------------------------------------------ */

bot.launch().then(() => {
  console.log('Bot started');
});

const app = express();

app.get('/', (req, res) => {
  res.send('Groovia bot is running 🟢');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('HTTP server on port', PORT);
});

// graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
