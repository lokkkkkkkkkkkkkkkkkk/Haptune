// One Piece model. A piece shows up in many places (your library, the free library, Stage scores and requests, a
// class assignment, a Sound); every list, search result, shelf and link describes it the same way:
//   { type, id, title, sub, instrument, genre, level, keyText, icon, src }
// type: piece | catalog | post | request | assignment | class | person | sound
// The same file holds the app's deep links (#piece/ID/practise …) and the "what next" chips that end each flow.
// Plain data in and out, no screen code, so it is tested in node (tests/piece.test.mjs).

const j = (...xs) => xs.filter((x) => x !== undefined && x !== null && x !== '').join(' · ');

/** A piece in your library (state.pieces meta). */
export function fromLibrary(p) {
  return { type: 'piece', id: p.id, title: p.title, sub: j(p.composer, p.keyText), instrument: p.instrument, genre: (p.tags || [])[0],
    level: p.level || 0, keyText: p.keyText, measures: p.measures, best: p.best ?? null, src: 'library', chordSong: !!p.chordSong, catalogId: p.catalogId || null };
}
/** A piece in the free library (catalog index row). */
export function fromCatalog(r) {
  return { type: 'catalog', id: r.id, title: r.title, sub: j(r.composer), instrument: r.instrument, genre: r.genre, level: r.level || 0, src: 'free' };
}
/** A Stage post: a shared score, a request, a question. */
export function fromPost(p) {
  const request = p.type === 'request' || p.kind === 'request';
  return { type: request ? 'request' : 'post', id: p.id, title: p.title, sub: j(p.artist, p.author?.name || p.by), instrument: p.instrument,
    icon: request ? 'flag' : 'staff', wants: p.wants || 0, src: 'stage' };
}
/** A class assignment (academy row). */
export function fromAssignment(a) {
  return { type: 'assignment', id: a.id, classId: a.class_id || a.classId, title: a.title, sub: j(a.piece_title || a.piece, a.class), due: a.due || a.due_at || null, icon: 'flag', src: 'class' };
}
export function fromClass(c) { return { type: 'class', id: c.id, title: c.title || c.name, sub: c.sub || c.instrument || '', icon: 'academy', src: 'class' }; }
export function fromPerson(u) { return { type: 'person', id: u.handle, title: u.name || u.handle, sub: `@${u.handle}`, icon: 'person', src: 'people' }; }
export function fromSound(x) { return { type: 'sound', id: x.id, title: x.title, sub: j(x.by || x.author?.name, x.seconds ? `${Math.round(x.seconds)}s` : x.sub), genre: 'sound', icon: 'wave', src: 'sounds' }; }

/** The search result groups, in the order they are shown, and the type chip each belongs to. */
export const RESULT_TYPES = ['pieces', 'classes', 'people', 'sounds', 'posts'];
export const typeOf = (item) => ({ piece: 'pieces', catalog: 'pieces', request: 'pieces', post: 'posts', assignment: 'classes', class: 'classes', person: 'people', sound: 'sounds' }[item.type]);

// ---------------------------------------------------------------- deep links
// #piece/ID            the piece          #piece/ID/practise   straight into Play Along     #piece/ID/create  its studio
// #class/ID            the class          #class/ID/assignment/AID                            #stage/post/ID    a Stage post
// #stage/post/ID/v/RID  someone's own version in a comment, opened at once
// #sound/ID            a Sound            older links still work: #post/ID, #u/handle, #join/CODE, #q=…
const ID = '([A-Za-z0-9_.-]{2,80})';
const ROUTES = [
  [new RegExp(`^piece/${ID}(?:/(practise|practice|create|listen))?$`), (m) => ({ route: 'piece', id: m[1], action: m[2] === 'practice' ? 'practise' : (m[2] || null) })],
  [new RegExp(`^class/${ID}/assignment/${ID}$`), (m) => ({ route: 'assignment', classId: m[1], id: m[2] })],
  [new RegExp(`^class/${ID}$`), (m) => ({ route: 'class', id: m[1] })],
  [new RegExp(`^(?:stage/)?post/${ID}$`), (m) => ({ route: 'post', id: m[1] })],
  [new RegExp(`^(?:stage/)?post/${ID}/v/${ID}$`), (m) => ({ route: 'post', id: m[1], version: m[2] })],
  [new RegExp(`^sound/${ID}$`), (m) => ({ route: 'sound', id: m[1] })],
  [/^u\/([a-z0-9_.]{3,20})$/, (m) => ({ route: 'person', id: m[1] })],
];
/** "#piece/abc/practise" -> { route: 'piece', id: 'abc', action: 'practise' }; null when it isn't one of these links. */
export function parseLink(hash) {
  const h = String(hash || '').replace(/^#/, '');
  let d = h;
  try { d = decodeURIComponent(h); } catch { /* keep as is */ }
  for (const [re, f] of ROUTES) { const m = re.exec(d); if (m) return f(m); }
  return null;
}
/** The link (hash) for an item, optionally straight into an action. */
export function linkFor(item, action = null) {
  const e = encodeURIComponent;
  switch (item.type) {
    case 'piece': case 'catalog': return `#piece/${e(item.catalogId || item.id)}${action ? `/${action}` : ''}`;
    case 'assignment': return item.classId ? `#class/${e(item.classId)}/assignment/${e(item.id)}` : null;
    case 'class': return `#class/${e(item.id)}`;
    case 'post': case 'request': return `#stage/post/${e(item.id)}`;
    case 'sound': return `#sound/${e(item.id)}`;
    case 'person': return `#u/${e(item.id)}`;
    default: return null;
  }
}
/** A full web address for sharing (site + /app/ + link). */
export const shareURL = (site, item, action) => { const l = linkFor(item, action); return l ? `${String(site).replace(/\/+$/, '')}/app/${l}` : null; };

// ---------------------------------------------------------------- what next
// Every flow ends with a short row of chips for the likely next step, so nobody hits a dead end.
// flow: take | create | handIn | post | request | sound | join
// Returns [{ id, icon, label, primary? }]: the screen maps each id to what it does.
export function nextSteps(flow, ctx = {}) {
  const out = [];
  const add = (id, icon, label, primary = false) => out.push({ id, icon, label, primary });
  switch (flow) {
    case 'take': {
      const acc = ctx.accuracy ?? 0, speed = ctx.speed ?? 1;
      let used = false;
      const first = () => (used ? false : (used = true));
      if (ctx.duel && !ctx.duelSent) add('sendDuel', 'trophy', 'nxSendDuel', first());
      if (ctx.assignment && !ctx.sent) add('handIn', 'send', 'nxHandIn', first());
      if (acc >= 0.85 && speed < 1.5) add('faster', 'bolt', 'nxFaster', first());
      else if (ctx.tricky) add('loopTricky', 'loop', 'nxLoopTricky', first());
      else add('again', 'mic', 'nxAgain', first());
      if (ctx.online && !ctx.assignment && ctx.inClass) add('shareClass', 'academy', 'nxShareClass');
      if (ctx.online && !ctx.duel && acc >= 0.5) add('challengeFriend', 'trophy', 'nxChallengeFriend');
      if (ctx.online && acc >= 0.7) add('shareStage', 'stage', 'nxShareStage');
      add('similar', 'sparkles', 'nxSimilar');
      break;
    }
    case 'create':
      add('playAlong', 'play', 'nxPlayAlong', true);
      if (ctx.online) add('shareStage', 'stage', 'nxShareStage');
      if (ctx.teacher) add('assign', 'academy', 'nxAssign');
      add('export', 'download', 'nxExport');
      break;
    case 'handIn':
      if (ctx.nextAssignment) add('nextAssignment', 'flag', 'nxNextAssignment', true);
      add('again', 'mic', 'nxAgain', !ctx.nextAssignment);
      add('classPage', 'academy', 'nxClass');
      break;
    case 'post':
      add('viewPost', 'stage', 'nxViewPost', true);
      add('copyLink', 'link', 'nxCopyLink');
      add('findMore', 'search', 'nxFindMore');
      break;
    case 'request':
      add('viewPost', 'flag', 'nxViewRequest', true);
      add('copyLink', 'link', 'nxCopyLink');
      add('openRequests', 'stage', 'nxOpenRequests');
      break;
    case 'sound':
      add('viewSound', 'wave', 'nxViewSound', true);
      add('copyLink', 'link', 'nxCopyLink');
      add('newSound', 'mic', 'nxNewSound');
      break;
    case 'join':
      if (ctx.nextAssignment) add('nextAssignment', 'flag', 'nxNextAssignment', true);
      add('classPage', 'academy', 'nxClass', !ctx.nextAssignment);
      add('findSongs', 'search', 'nxFindMore');
      break;
    default: break;
  }
  return out;
}
