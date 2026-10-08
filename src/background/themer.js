/**
 * Themer (https://github.com/jliima/themer) integration, through its native messaging host
 * "themer" (plugins/browser in the Themer repository):
 *
 * 1. Theme variables. The tokens of the applied theme are exposed to user styles as CSS variables
 *    on :root, named as in Themer's colors.css: var(--themer-accent), var(--themer-bg),
 *    var(--themer-font-sans), var(--themer-radius-md), ... They are injected only where an applied
 *    style mentions --themer-, and `themer apply` updates them in open tabs at once.
 *
 * 2. A styles folder. Every UserCSS style is mirrored to a *.user.css file in a folder the host
 *    owns (by default stylus/ in Themer's config folder), both ways: edits in the browser are
 *    written to the file, and a file edited, added or deleted outside the browser updates,
 *    installs or deletes the style. Pref "themer.styles" turns it off. Classic (non-UserCSS)
 *    styles are not mirrored. Files in subfolders count too, and a file moved to another name or
 *    folder keeps its style, with its state. New styles get a file at the top of the folder.
 */
import {UCD} from '@/js/consts';
import * as prefs from '@/js/prefs';
import {sendTab} from './broadcast';
import {bgBusy} from './common';
import * as styleMan from './style-manager';
import {hooks, styleMap} from './style-manager/util';
import * as usercssMan from './usercss-manager';

/** The id of the virtual section holding the variables; real styles have positive ids. */
export const THEMER_ID = -1;
export const pThemerStyles = 'themer.styles';
const HOST = 'themer';
const VAR_PREFIX = '--themer-';
const FILE_SUFFIX = '.user.css';
/** Saves made by this module, which must not be written back to their file. */
const REASON = 'themer';
const RETRY_MIN = 5e3;
const RETRY_MAX = 5 * 60e3;

const ready = bgBusy;
let port = null;
let retryDelay = RETRY_MIN;
let varsCode = '';
let foldering = false;
/** @type {Map<string,{code: string, mtime: number}>} the files of the initial listing */
let listing = null;
/** @type {Map<number,string>} style id -> source code last written to or read from its file */
const synced = new Map();

/**
 * The variables section for a page, when one of the sections applied to it uses them.
 * @param {Injection.Sections[]} sections
 */
export function themerSection(sections) {
  if (varsCode && sections.some(usesVars))
    return {id: THEMER_ID, code: [varsCode], name: 'Themer'};
}

function usesVars(sec) {
  return sec.id !== THEMER_ID && sec.code.some(c => c.includes(VAR_PREFIX));
}

function buildVars({colors = {}, fonts = {}, shape = {}} = {}) {
  const decl = [];
  for (const [k, v] of Object.entries(colors)) decl.push(`${VAR_PREFIX}${k}: ${v};`);
  for (const [k, v] of Object.entries(fonts))
    decl.push(`${VAR_PREFIX}font-${k}: ${typeof v === 'string' ? JSON.stringify(v) : v};`);
  for (const [k, v] of Object.entries(shape)) decl.push(`${VAR_PREFIX}${k}: ${v}px;`);
  return decl.length ? `:root {\n  ${decl.join('\n  ')}\n}` : '';
}

async function onTheme(tokens) {
  const code = tokens ? buildVars(tokens) : '';
  if (code === varsCode) return;
  varsCode = code;
  // The content script asks for the section again and adds, replaces or removes it.
  const msg = {method: 'styleUpdated', style: {id: THEMER_ID, enabled: true}, reason: REASON};
  for (const tab of await browser.tabs.query({})) {
    if (!tab.discarded && tab.url) sendTab(tab.id, msg).catch(() => {});
  }
}

// -------------------------------------------------------------------------------------------------
// Styles folder
// -------------------------------------------------------------------------------------------------

const isUsercss = style => !!style?.[UCD] && typeof style.sourceCode === 'string';
const findByFile = file => [...styleMap.values()].find(s => s.themerFile === file);

function fileNameFor(style) {
  const used = new Set([...styleMap.values()].map(s => s.themerFile).filter(Boolean));
  if (listing) for (const f of listing.keys()) used.add(f);
  const base = (style.customName || style.name || 'style')
    .toLowerCase().normalize('NFKD').replace(/[^\w]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'style';
  for (let i = 1, name = base; ; name = `${base}-${++i}`) {
    if (!used.has(name + FILE_SUFFIX)) return name + FILE_SUFFIX;
  }
}

function writeFile(style, file = style.themerFile) {
  synced.set(style.id, style.sourceCode);
  port?.postMessage({type: 'style-write', file, code: style.sourceCode});
}

/** Links a style to a file without counting as an edit of the style. */
async function link(style, file) {
  if (style.themerFile === file) return;
  style.themerFile = file;
  await styleMan.save(style, false);
}

/** Exports a UserCSS style that has no file yet. */
async function exportStyle(style) {
  await link(style, fileNameFor(style));
  writeFile(style);
}

/** Installs or updates the style of a file from its code. */
async function importFile(file, code) {
  const linked = findByFile(file);
  if (linked && linked.sourceCode === code) {
    synced.set(linked.id, code);
    return;
  }
  const {style, dup} = await usercssMan.build(code, {id: linked?.id, dup: true, vars: true});
  const target = linked || dup && !dup.themerFile && dup;
  if (target) {
    style.id = target.id;
    delete style.enabled; // keep it enabled or disabled as it was
  }
  style.themerFile = file;
  const saved = await styleMan.install(style, REASON);
  synced.set(saved.id, code);
}

async function reconcile(files) {
  for (const [file, {code, mtime}] of files) {
    try {
      const style = findByFile(file) || await matchByMeta(code);
      if (style && style.sourceCode !== code && (style.updateDate || 0) > mtime) {
        await link(style, file);
        writeFile(style); // edited in the browser since the file was last written
      } else {
        await importFile(file, code);
      }
    } catch (err) {
      report(`${file}: ${err.message || err}`);
    }
  }
  for (const style of styleMap.values()) {
    if (!isUsercss(style)) continue;
    if (style.themerFile && files.has(style.themerFile)) continue;
    // Not in the folder: new, or its file was deleted while the browser was closed.
    // Keeping the style is safer.
    try {
      await exportStyle(style);
    } catch (err) {
      report(`${style.name}: ${err.message || err}`);
    }
  }
}

async function matchByMeta(code) {
  try {
    const {dup} = await usercssMan.build(code, {dup: true, metaOnly: true});
    return dup && !dup.themerFile ? dup : null;
  } catch {
    return null;
  }
}

async function onFile(file, code, mtime) {
  if (listing) {
    listing.set(file, {code, mtime});
    return;
  }
  try {
    await importFile(file, code);
  } catch (err) {
    report(`${file}: ${err.message || err}`);
  }
}

/** A file moved or renamed outside the browser, its code unchanged. */
async function onFileMoved(from, file) {
  const style = findByFile(from);
  if (style) await link(style, file);
}

async function onFileRemoved(file) {
  const style = findByFile(file);
  if (style) {
    synced.delete(style.id);
    styleMan.remove(style.id, REASON);
  }
}

function onStyleSaved(style, reason) {
  // false: saved without a broadcast, e.g. by link() here
  if (!foldering || reason === REASON || reason === false || !isUsercss(style)) return;
  // e.g. toggled or reconfigured: the code is the same
  if (synced.get(style.id) === style.sourceCode) return;
  if (style.themerFile) writeFile(style);
  else exportStyle(style).catch(err => report(`${style.name}: ${err.message || err}`));
}

function onStyleRemoved(style, reason) {
  if (!foldering || reason === REASON || !style.themerFile) return;
  synced.delete(style.id);
  port?.postMessage({type: 'style-delete', file: style.themerFile});
}

// -------------------------------------------------------------------------------------------------
// Connection
// -------------------------------------------------------------------------------------------------

function report(message) {
  console.warn('Themer:', message);
  port?.postMessage({type: 'log', message});
}

/** Messages are handled one at a time, in order. */
let queue = Promise.resolve();

function onMessage(msg) {
  retryDelay = RETRY_MIN;
  queue = queue.then(() => ready).then(() => {
    switch (msg.type) {
      case 'theme': return onTheme(msg.tokens);
      case 'styles-begin': listing = new Map(); return;
      case 'style': return onFile(msg.file, msg.code, msg.mtime);
      case 'style-removed': return onFileRemoved(msg.file);
      case 'style-moved': return onFileMoved(msg.from, msg.file);
      case 'styles-end': {
        const files = listing;
        listing = null;
        foldering = true;
        return reconcile(files);
      }
      case 'error': console.warn('Themer host:', msg.message);
    }
  }).catch(err => report(err.message || `${err}`));
}

function connect() {
  port = chrome.runtime.connectNative(HOST);
  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError?.message;
    console.info(`Themer host disconnected${err ? `: ${err}` : ''};`,
      `retrying in ${retryDelay / 1e3} s`);
    port = null;
    foldering = false;
    listing = null;
    setTimeout(connect, retryDelay);
    retryDelay = Math.min(retryDelay * 2, RETRY_MAX);
  });
  const styles = prefs.__values[pThemerStyles];
  port.postMessage({type: 'hello', app: 'stylus', styles, moves: true});
}

if (chrome.runtime.connectNative) {
  hooks.saved = onStyleSaved;
  hooks.removed = onStyleRemoved;
  prefs.ready.then(connect);
  // A port closed from this side gets no onDisconnect event, so reconnect here.
  prefs.subscribe(pThemerStyles, () => {
    port?.disconnect();
    port = null;
    foldering = false;
    connect();
  }, false);
}
