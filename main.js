const { Plugin, Modal, Notice, PluginSettingTab, Setting } = require('obsidian');

// ─── FSRS-4.5 Algorithm ──────────────────────────────────────────────────────
//
// 17 default weights from open-spaced-repetition/ts-fsrs (FSRS-4.5).
// Grades: 1 = Again, 2 = Hard, 3 = Good, 4 = Easy
//
// Frontmatter written per note:
//   sr-due            – next review date (YYYY-MM-DD)
//   sr-stability      – memory stability S (days until 90 % retention)
//   sr-difficulty     – intrinsic difficulty D ∈ [1, 10]
//   sr-retrievability – recall probability at last review
//   sr-last-review    – date of last review (required for elapsed-days calc)

const FSRS_W = [
  0.4072, 1.1829, 3.1262, 15.4722, // w0-w3  : initial S for grades 1-4
  7.2102, 0.5316,                   // w4-w5  : initial difficulty
  1.0651, 0.0589,                   // w6-w7  : difficulty update / mean reversion
  1.5330, 0.1544, 1.0071,           // w8-w10 : recall stability
  1.9395, 0.1100, 0.2900, 2.2700,  // w11-w14: forget stability
  0.2500, 2.9898,                   // w15-w16: hard penalty / easy bonus
];

const DESIRED_RETENTION = 0.9;
const MAX_INTERVAL      = 36500;

function fsrsClamp(x, lo, hi) { return Math.min(Math.max(x, lo), hi); }

function fsrsInitStability(grade) {
  return Math.max(FSRS_W[grade - 1], 0.1);
}

function fsrsInitDifficulty(grade) {
  return fsrsClamp(FSRS_W[4] - Math.exp(FSRS_W[5] * (grade - 1)) + 1, 1, 10);
}

function fsrsRetrievability(elapsed, s) {
  return Math.exp(Math.log(DESIRED_RETENTION) * elapsed / s);
}

function fsrsRecallStability(d, s, r, grade) {
  const hardPenalty = grade === 2 ? FSRS_W[15] : 1;
  const easyBonus   = grade === 4 ? FSRS_W[16] : 1;
  return s * (
    Math.exp(FSRS_W[8]) *
    (11 - d) *
    Math.pow(s, -FSRS_W[9]) *
    (Math.exp((1 - r) * FSRS_W[10]) - 1) *
    hardPenalty * easyBonus + 1
  );
}

function fsrsForgetStability(d, s, r) {
  return FSRS_W[11] *
    Math.pow(d,      -FSRS_W[12]) *
    (Math.pow(s + 1,  FSRS_W[13]) - 1) *
    Math.exp((1 - r) * FSRS_W[14]);
}

function fsrsNextDifficulty(d, grade) {
  const d0_easy = fsrsInitDifficulty(4);
  const raw     = d - FSRS_W[6] * (grade - 3);
  return fsrsClamp(FSRS_W[7] * d0_easy + (1 - FSRS_W[7]) * raw, 1, 10);
}

/** Next interval with ±5 % fuzz to prevent card clustering. */
function fsrsNextInterval(s) {
  const base = fsrsClamp(Math.round(s), 1, MAX_INTERVAL);
  if (base < 2) return base;
  const fuzz = Math.random() * 0.10 - 0.05;
  return fsrsClamp(Math.round(base * (1 + fuzz)), 1, MAX_INTERVAL);
}

/**
 * Full FSRS scheduling step.
 * @param {1|2|3|4} grade
 * @param {number|null} prevS   – sr-stability (null = new note)
 * @param {number|null} prevD   – sr-difficulty (null = new note)
 * @param {number}      elapsed – days since last review
 */
function fsrs(grade, prevS, prevD, elapsed) {
  const isNew = prevS == null;
  let s, d, r;

  if (isNew) {
    s = fsrsInitStability(grade);
    d = fsrsInitDifficulty(grade);
    r = 0;
  } else {
    r = fsrsRetrievability(elapsed, prevS);
    d = fsrsNextDifficulty(prevD, grade);
    s = grade === 1
      ? fsrsForgetStability(prevD, prevS, r)
      : fsrsRecallStability(prevD, prevS, r, grade);
  }

  s = Math.max(s, 0.1);
  const interval = fsrsNextInterval(s);
  const due = new Date();
  due.setDate(due.getDate() + interval);

  return {
    stability:      parseFloat(s.toFixed(4)),
    difficulty:     parseFloat(d.toFixed(4)),
    retrievability: parseFloat((isNew ? 0 : r).toFixed(4)),
    interval,
    nextDue: due.toISOString().split('T')[0],
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatInterval(days) {
  if (days <= 1)  return '1 Tag';
  if (days < 7)   return `${days} Tage`;
  if (days < 14)  return '1 Woche';
  if (days < 30)  return `${Math.round(days / 7)} Wochen`;
  const m = days / 30;
  if (m < 1.5)    return '1 Monat';
  if (m < 12)     return `${m.toFixed(1)} Monate`;
  return `${(days / 365).toFixed(1)} Jahre`;
}

function daysBetween(a, b) {
  return Math.max(0, Math.round((new Date(b) - new Date(a)) / 86400000));
}

/** Fisher-Yates shuffle – mutates and returns the array. */
function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ─── Settings ────────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS = {
  reviewTags:   ['review'],
  dailyGoal:    20,
  maxNewPerDay: 20,
  keyModifier:  'meta',   // 'meta' | 'alt'
  // runtime (persisted, not shown in settings UI):
  reviewedToday:    0,
  newReviewedToday: 0,
  lastReviewDate:   '',
  streak:           0,
  lastStreakDate:   '',
};

// ─── Stats Modal ──────────────────────────────────────────────────────────────

class NoteReviewStatsModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
  }

  async onOpen() {
    const { contentEl } = this;
    contentEl.addClass('note-review-stats-modal');
    contentEl.createEl('h2', { text: '📊 Review-Statistiken' });
    const loading = contentEl.createEl('p', { text: 'Lade…', cls: 'stats-loading' });

    const stats = await this.computeStats();
    loading.remove();
    this.renderStats(stats);
  }

  async computeStats() {
    const tags    = this.plugin.settings.reviewTags.map(t => t.toLowerCase());
    const today   = new Date().toISOString().split('T')[0];
    const inDays  = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().split('T')[0]; };

    let total = 0, newNotes = 0, dueToday = 0, dueThisWeek = 0;
    let stabilitySum = 0, stabilityCount = 0;
    let difficultySum = 0, difficultyCount = 0;

    for (const file of this.app.vault.getMarkdownFiles()) {
      const cache = this.app.metadataCache.getFileCache(file);
      const meta  = cache?.frontmatter;

      const inlineTags      = (cache?.tags || []).map(t => t.tag.replace(/^#/, '').toLowerCase());
      const frontmatterTags = Array.isArray(meta?.tags)
        ? meta.tags.map(t => String(t).replace(/^#/, '').toLowerCase()) : [];
      if (!tags.some(t => [...new Set([...inlineTags, ...frontmatterTags])].includes(t))) continue;

      total++;
      const s = meta?.['sr-stability'];
      const d = meta?.['sr-difficulty'];
      const due = meta?.['sr-due'];

      if (!s) newNotes++;
      if (s) { stabilitySum += s; stabilityCount++; }
      if (d) { difficultySum += d; difficultyCount++; }
      if (due && due <= today)        dueToday++;
      if (due && due <= inDays(7))    dueThisWeek++;
    }

    return {
      total,
      newNotes,
      reviewed:        total - newNotes,
      dueToday,
      dueThisWeek,
      avgStability:    stabilityCount  ? (stabilitySum  / stabilityCount).toFixed(1)  : '–',
      avgDifficulty:   difficultyCount ? (difficultySum / difficultyCount).toFixed(1) : '–',
      reviewedToday:   this.plugin.settings.reviewedToday    || 0,
      dailyGoal:       this.plugin.settings.dailyGoal        || 20,
      streak:          this.plugin.settings.streak           || 0,
    };
  }

  renderStats(s) {
    const { contentEl } = this;

    const grid = contentEl.createEl('div', { cls: 'stats-grid' });
    const items = [
      { value: s.total,              label: 'Notizen gesamt',    sub: `${s.newNotes} neu · ${s.reviewed} bekannt` },
      { value: s.dueToday,           label: 'Fällig heute',      sub: `${s.dueThisWeek} diese Woche` },
      { value: `${s.reviewedToday} / ${s.dailyGoal}`, label: 'Heute reviewt', sub: 'Tagesziel' },
      { value: `${s.streak} 🔥`,    label: 'Streak',            sub: 'Tage in Folge' },
      { value: `${s.avgStability} T`, label: 'Ø Stabilität',    sub: 'Gedächtnishorizont' },
      { value: s.avgDifficulty,      label: 'Ø Schwierigkeit',   sub: 'Skala 1 – 10' },
    ];

    for (const item of items) {
      const card = grid.createEl('div', { cls: 'stats-card' });
      card.createEl('div', { cls: 'stats-value', text: String(item.value) });
      card.createEl('div', { cls: 'stats-label', text: item.label });
      card.createEl('div', { cls: 'stats-sub',   text: item.sub });
    }
  }

  onClose() { this.contentEl.empty(); }
}

// ─── Review Panel ─────────────────────────────────────────────────────────────

class NoteReviewPanel {
  constructor(app, notes, plugin) {
    this.app          = app;
    this.notes        = notes;   // mutable – skip pushes to end
    this.plugin       = plugin;
    this.current      = 0;
    this.el           = null;
    this.sessionCount = 0;
    this.lastRated    = null;    // cache for single-level undo
  }

  async open() {
    this.el = document.body.createEl('div', { cls: 'note-review-panel' });
    this.render();
    await this.openCurrentNote();

    const modifier = this.plugin.settings.keyModifier || 'meta';
    this.keyHandler = (e) => {
      const active = modifier === 'meta' ? e.metaKey : e.altKey;
      if (!active) return;
      const grade = { '1': 1, '2': 2, '3': 3, '4': 4 }[e.key];
      if (!grade) return;
      e.preventDefault();
      if (this.current < this.notes.length) this.rate(this.notes[this.current], grade);
    };
    document.addEventListener('keydown', this.keyHandler);
  }

  async openCurrentNote() {
    if (this.current >= this.notes.length) return;
    const file = this.app.vault.getAbstractFileByPath(this.notes[this.current].path);
    if (file) await this.app.workspace.getLeaf(false).openFile(file);
  }

  getPreviewIntervals(note) {
    const file    = this.app.vault.getAbstractFileByPath(note.path);
    const meta    = file ? (this.app.metadataCache.getFileCache(file)?.frontmatter || {}) : {};
    const prevS   = meta['sr-stability']   ?? null;
    const prevD   = meta['sr-difficulty']  ?? null;
    const lastRev = meta['sr-last-review'] ?? null;
    const today   = new Date().toISOString().split('T')[0];
    const elapsed = lastRev ? daysBetween(lastRev, today) : 0;
    return {
      again: formatInterval(fsrs(1, prevS, prevD, elapsed).interval),
      hard:  formatInterval(fsrs(2, prevS, prevD, elapsed).interval),
      good:  formatInterval(fsrs(3, prevS, prevD, elapsed).interval),
      easy:  formatInterval(fsrs(4, prevS, prevD, elapsed).interval),
    };
  }

  render() {
    this.el.empty();

    const goal        = this.plugin.settings.dailyGoal    || 20;
    const done        = this.plugin.settings.reviewedToday || 0;
    const progressPct = Math.min(100, (done / goal) * 100);

    // Progress bar
    const bar = this.el.createEl('div', { cls: 'note-review-progress-bar' });
    bar.createEl('div', { cls: 'note-review-progress-fill' }).style.width = `${progressPct}%`;

    const inner = this.el.createEl('div', { cls: 'note-review-panel-inner' });

    // ── Completion screen ────────────────────────────────────────────────────
    if (this.current >= this.notes.length) {
      const doneEl = inner.createEl('div', { cls: 'note-review-panel-done' });
      doneEl.createEl('span', { cls: 'done-icon', text: '✅' });
      doneEl.createEl('span', { cls: 'done-text',
        text: `Session beendet – ${this.sessionCount} Notizen reviewt` });
      doneEl.createEl('span', {
        cls: `note-review-stat${done >= goal ? ' goal-reached' : ''}`,
        text: `${done} / ${goal} heute`,
      });
      if ((this.plugin.settings.streak || 0) > 0) {
        doneEl.createEl('span', { cls: 'note-review-stat streak-pill',
          text: `🔥 ${this.plugin.settings.streak} Tage Streak` });
      }
      const closeBtn = inner.createEl('button', { cls: 'note-review-panel-close', text: '×' });
      closeBtn.addEventListener('click', () => this.close());
      return;
    }

    // ── Active review ────────────────────────────────────────────────────────
    const note      = this.notes[this.current];
    const intervals = this.getPreviewIntervals(note);
    const modSymbol = this.plugin.settings.keyModifier === 'meta' ? '⌘' : '⌥';

    // Left: title + stats
    const left = inner.createEl('div', { cls: 'note-review-panel-left' });
    left.createEl('span', { cls: 'note-review-panel-title', text: note.basename });
    const statsEl = left.createEl('div', { cls: 'note-review-panel-stats' });
    statsEl.createEl('span', { cls: 'note-review-stat',
      text: `${this.current + 1} / ${this.notes.length} fällig` });
    statsEl.createEl('span', {
      cls: `note-review-stat note-review-goal${done >= goal ? ' goal-reached' : ''}`,
      text: `${done} / ${goal} Ziel`,
    });
    if ((this.plugin.settings.streak || 0) > 0) {
      statsEl.createEl('span', { cls: 'note-review-stat streak-pill',
        text: `🔥 ${this.plugin.settings.streak}` });
    }

    // Center: rating cards
    const buttons = inner.createEl('div', { cls: 'note-review-panel-buttons' });
    const cards = [
      { emoji: '⏭',  label: 'Später',    interval: '↩',            cls: 'btn-skip',  action: () => this.skip(),          shortcut: null },
      { emoji: '❌',  label: 'Vergessen', interval: intervals.again, cls: 'btn-again', action: () => this.rate(note, 1),   shortcut: `${modSymbol}1` },
      { emoji: '😬', label: 'Schwer',     interval: intervals.hard,  cls: 'btn-hard',  action: () => this.rate(note, 2),   shortcut: `${modSymbol}2` },
      { emoji: '😊', label: 'Gut',        interval: intervals.good,  cls: 'btn-good',  action: () => this.rate(note, 3),   shortcut: `${modSymbol}3` },
      { emoji: '👑', label: 'Leicht',     interval: intervals.easy,  cls: 'btn-easy',  action: () => this.rate(note, 4),   shortcut: `${modSymbol}4` },
    ];

    for (const c of cards) {
      const card = buttons.createEl('button', { cls: `note-review-card ${c.cls}` });
      card.createEl('span', { cls: 'card-emoji',    text: c.emoji    });
      card.createEl('span', { cls: 'card-label',    text: c.label    });
      card.createEl('span', { cls: 'card-interval', text: c.interval });
      if (c.shortcut) card.createEl('span', { cls: 'card-shortcut', text: c.shortcut });
      card.addEventListener('click', c.action);
    }

    // Right: undo + close
    const right = inner.createEl('div', { cls: 'note-review-panel-right' });
    if (this.lastRated) {
      const undoBtn = right.createEl('button', { cls: 'note-review-undo', text: '↩', attr: { title: 'Letzte Bewertung rückgängig' } });
      undoBtn.addEventListener('click', () => this.undo());
    }
    const closeBtn = right.createEl('button', { cls: 'note-review-panel-close', text: '×' });
    closeBtn.addEventListener('click', () => this.close());
  }

  /** Push current note to end of queue instead of dropping it. */
  skip() {
    const note = this.notes[this.current];
    this.notes.splice(this.current, 1);
    this.notes.push(note);
    this.render();
    this.openCurrentNote();
  }

  async rate(note, grade) {
    const file = this.app.vault.getAbstractFileByPath(note.path);
    if (!file) return;

    const meta    = this.app.metadataCache.getFileCache(file)?.frontmatter || {};
    const prevS   = meta['sr-stability']   ?? null;
    const prevD   = meta['sr-difficulty']  ?? null;
    const lastRev = meta['sr-last-review'] ?? null;
    const today   = new Date().toISOString().split('T')[0];
    const elapsed = lastRev ? daysBetween(lastRev, today) : 0;

    // Cache current state for undo
    this.lastRated = {
      note,
      index: this.current,
      prevValues: {
        'sr-due':            meta['sr-due']            ?? null,
        'sr-stability':      meta['sr-stability']      ?? null,
        'sr-difficulty':     meta['sr-difficulty']     ?? null,
        'sr-retrievability': meta['sr-retrievability'] ?? null,
        'sr-last-review':    meta['sr-last-review']    ?? null,
      },
    };

    const result = fsrs(grade, prevS, prevD, elapsed);
    const isNew  = prevS == null;

    await this.app.fileManager.processFrontMatter(file, fm => {
      fm['sr-due']            = result.nextDue;
      fm['sr-stability']      = result.stability;
      fm['sr-difficulty']     = result.difficulty;
      fm['sr-retrievability'] = result.retrievability;
      fm['sr-last-review']    = today;
      // Remove legacy SM-2 fields
      delete fm['sr-repetitions'];
      delete fm['sr-ease'];
      delete fm['sr-interval'];
    });

    this.plugin.settings.reviewedToday    = (this.plugin.settings.reviewedToday    || 0) + 1;
    if (isNew) this.plugin.settings.newReviewedToday = (this.plugin.settings.newReviewedToday || 0) + 1;
    this.updateStreak();
    await this.plugin.saveSettings();

    this.sessionCount++;
    this.current++;
    this.render();
    await this.openCurrentNote();
  }

  async undo() {
    if (!this.lastRated) return;
    const { note, index, prevValues } = this.lastRated;
    const file = this.app.vault.getAbstractFileByPath(note.path);
    if (!file) return;

    await this.app.fileManager.processFrontMatter(file, fm => {
      for (const [key, val] of Object.entries(prevValues)) {
        if (val === null) delete fm[key];
        else fm[key] = val;
      }
    });

    this.plugin.settings.reviewedToday = Math.max(0, (this.plugin.settings.reviewedToday || 1) - 1);
    await this.plugin.saveSettings();

    this.sessionCount = Math.max(0, this.sessionCount - 1);
    this.current   = index;
    this.lastRated = null;
    this.render();
    await this.openCurrentNote();
  }

  updateStreak() {
    const today = new Date().toISOString().split('T')[0];
    if (this.plugin.settings.lastStreakDate === today) return;

    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yStr = yesterday.toISOString().split('T')[0];

    if (this.plugin.settings.lastStreakDate === yStr) {
      this.plugin.settings.streak = (this.plugin.settings.streak || 0) + 1;
    } else {
      this.plugin.settings.streak = 1; // reset or start fresh
    }
    this.plugin.settings.lastStreakDate = today;
  }

  close() {
    document.removeEventListener('keydown', this.keyHandler);
    this.el.remove();
    this.plugin.activePanel = null;
  }
}

// ─── Settings Tab ─────────────────────────────────────────────────────────────

class NoteReviewSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'Note Review Einstellungen' });

    new Setting(containerEl)
      .setName('Review Tags')
      .setDesc('Welche Tags sollen für das Review erkannt werden? (kommagetrennt, ohne #)')
      .addText(text => text
        .setPlaceholder('review, remnote')
        .setValue(this.plugin.settings.reviewTags.join(', '))
        .onChange(async value => {
          this.plugin.settings.reviewTags = value.split(',').map(t => t.trim().replace(/^#/, '').toLowerCase());
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Tagesziel')
      .setDesc('Wie viele Notizen möchtest du täglich wiederholen?')
      .addSlider(slider => slider
        .setLimits(1, 100, 1)
        .setValue(this.plugin.settings.dailyGoal)
        .setDynamicTooltip()
        .onChange(async value => {
          this.plugin.settings.dailyGoal = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Max. neue Notizen pro Tag')
      .setDesc('Wie viele noch nie reviewte Notizen sollen täglich neu eingeführt werden?')
      .addSlider(slider => slider
        .setLimits(0, 50, 1)
        .setValue(this.plugin.settings.maxNewPerDay)
        .setDynamicTooltip()
        .onChange(async value => {
          this.plugin.settings.maxNewPerDay = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Tastaturkürzel')
      .setDesc('Welche Modifier-Taste soll für ⌘/⌥ 1-4 verwendet werden?')
      .addDropdown(drop => drop
        .addOption('meta', '⌘ Cmd (Mac) / Ctrl (Win)')
        .addOption('alt',  '⌥ Alt / Option')
        .setValue(this.plugin.settings.keyModifier || 'meta')
        .onChange(async value => {
          this.plugin.settings.keyModifier = value;
          await this.plugin.saveSettings();
        }));
  }
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

module.exports = class NoteReviewPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    await this.resetDailyCountIfNeeded();
    this.activePanel = null;

    this.addSettingTab(new NoteReviewSettingTab(this.app, this));
    this.addRibbonIcon('brain',       'Note Review starten',     () => this.startReview());
    this.addRibbonIcon('bar-chart-2', 'Review-Statistiken',      () => new NoteReviewStatsModal(this.app, this).open());

    this.addCommand({
      id: 'start-note-review',
      name: 'Review starten',
      callback: () => this.startReview(),
    });

    this.addCommand({
      id: 'show-review-stats',
      name: 'Statistiken anzeigen',
      callback: () => new NoteReviewStatsModal(this.app, this).open(),
    });

    this.addCommand({
      id: 'add-current-note-to-review',
      name: 'Diese Notiz zum Review hinzufügen',
      callback: () => this.addCurrentNote(),
    });
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async resetDailyCountIfNeeded() {
    const today = new Date().toISOString().split('T')[0];
    if (this.settings.lastReviewDate === today) return;

    // Break streak if more than one day was missed
    if (this.settings.lastStreakDate) {
      const gap = daysBetween(this.settings.lastStreakDate, today);
      if (gap > 1) this.settings.streak = 0;
    }

    this.settings.reviewedToday    = 0;
    this.settings.newReviewedToday = 0;
    this.settings.lastReviewDate   = today;
    await this.saveSettings();
  }

  async addCurrentNote() {
    const file = this.app.workspace.getActiveFile();
    if (!file) { new Notice('Keine aktive Notiz'); return; }
    const today = new Date().toISOString().split('T')[0];
    await this.app.fileManager.processFrontMatter(file, fm => {
      if (!fm['sr-due']) fm['sr-due'] = today;
    });
    new Notice(`✅ "${file.basename}" zum Review hinzugefügt`);
  }

  async startReview() {
    // Prevent multiple simultaneous panels
    if (this.activePanel) {
      new Notice('Ein Review läuft bereits.');
      return;
    }

    await this.resetDailyCountIfNeeded();

    const today     = new Date().toISOString().split('T')[0];
    const tags      = this.settings.reviewTags.map(t => t.toLowerCase());
    const maxNew    = this.settings.maxNewPerDay ?? 20;
    const newDone   = this.settings.newReviewedToday || 0;
    let   newQueued = 0;

    const reviewDue = [];  // notes with existing sr-stability
    const newDue    = [];  // notes without sr-stability (first time)

    for (const file of this.app.vault.getMarkdownFiles()) {
      const cache = this.app.metadataCache.getFileCache(file);
      const meta  = cache?.frontmatter;

      const inlineTags      = (cache?.tags || []).map(t => t.tag.replace(/^#/, '').toLowerCase());
      const frontmatterTags = Array.isArray(meta?.tags)
        ? meta.tags.map(t => String(t).replace(/^#/, '').toLowerCase()) : [];
      const fileTags = [...new Set([...inlineTags, ...frontmatterTags])];

      // Skip notes without a matching review tag
      if (!tags.some(t => fileTags.includes(t))) continue;

      // First encounter: stamp sr-due = today
      if (!meta?.['sr-due']) {
        await this.app.fileManager.processFrontMatter(file, fm => {
          fm['sr-due'] = today;
        });
      }

      const updatedMeta = this.app.metadataCache.getFileCache(file)?.frontmatter;
      const dueDate     = updatedMeta?.['sr-due'];
      if (!dueDate || dueDate > today) continue;

      const isNew = !updatedMeta?.['sr-stability'];

      if (isNew) {
        if (newDone + newQueued >= maxNew) continue; // daily new-note cap reached
        newQueued++;
        newDue.push({ path: file.path, basename: file.basename });
      } else {
        reviewDue.push({ path: file.path, basename: file.basename });
      }
    }

    // Shuffle each group independently, then put due reviews first
    const due = [...shuffleArray(reviewDue), ...shuffleArray(newDue)];

    if (due.length === 0) {
      new Notice('🎉 Keine Notizen fällig heute!');
      return;
    }

    this.activePanel = new NoteReviewPanel(this.app, due, this);
    await this.activePanel.open();
  }
};
