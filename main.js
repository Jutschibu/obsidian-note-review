const { Plugin, Modal, Notice, TFile } = require('obsidian');

// SM-2 Algorithmus
function sm2(quality, repetitions, easeFactor, interval) {
  if (quality >= 3) {
    if (repetitions === 0) interval = 1;
    else if (repetitions === 1) interval = 6;
    else interval = Math.round(interval * easeFactor);
    repetitions += 1;
    easeFactor = Math.max(1.3, easeFactor + 0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02));
  } else {
    repetitions = 0;
    interval = 1;
  }
  const nextReview = new Date();
  nextReview.setDate(nextReview.getDate() + interval);
  return { repetitions, easeFactor, interval, nextReview: nextReview.toISOString().split('T')[0] };
}

class NoteReviewModal extends Modal {
  constructor(app, notes, plugin) {
    super(app);
    this.notes = notes;
    this.plugin = plugin;
    this.current = 0;
  }

  onOpen() {
    this.modalEl.addClass('note-review-modal');
    this.render();
  }

  render() {
    const { contentEl } = this;
    contentEl.empty();

    if (this.current >= this.notes.length) {
      contentEl.createEl('div', { cls: 'note-review-container' }).createEl('div', { cls: 'note-review-empty' }).innerHTML =
        '<div class="checkmark">✅</div><p><strong>Alle Notizen für heute erledigt!</strong></p><p>Gut gemacht.</p>';
      return;
    }

    const note = this.notes[this.current];
    const container = contentEl.createEl('div', { cls: 'note-review-container' });

    // Header
    const header = container.createEl('div', { cls: 'note-review-header' });
    header.createEl('h2', { text: 'Notiz-Review' });
    header.createEl('span', { cls: 'note-review-counter', text: `${this.current + 1} / ${this.notes.length}` });

    // Content
    const content = container.createEl('div', { cls: 'note-review-content' });
    content.createEl('div', { cls: 'note-review-title', text: note.basename });
    content.createEl('div', { cls: 'note-review-body', text: note.preview });

    // Buttons
    const buttons = container.createEl('div', { cls: 'note-review-buttons' });
    const ratings = [
      { label: '🔁 Nochmal', cls: 'btn-again', quality: 1 },
      { label: '😓 Schwer',  cls: 'btn-hard',  quality: 2 },
      { label: '👍 Gut',     cls: 'btn-good',  quality: 4 },
      { label: '⚡ Leicht',  cls: 'btn-easy',  quality: 5 },
    ];

    for (const r of ratings) {
      const btn = buttons.createEl('button', { cls: `note-review-btn ${r.cls}`, text: r.label });
      btn.addEventListener('click', () => this.rate(note, r.quality));
    }
  }

  async rate(note, quality) {
    const file = this.app.vault.getAbstractFileByPath(note.path);
    if (!file) return;

    const meta = this.app.metadataCache.getFileCache(file)?.frontmatter || {};
    const result = sm2(
      quality,
      meta['sr-repetitions'] || 0,
      meta['sr-ease'] || 2.5,
      meta['sr-interval'] || 1
    );

    await this.app.fileManager.processFrontMatter(file, fm => {
      fm['sr-due']         = result.nextReview;
      fm['sr-repetitions'] = result.repetitions;
      fm['sr-ease']        = parseFloat(result.easeFactor.toFixed(2));
      fm['sr-interval']    = result.interval;
    });

    this.current++;
    this.render();
  }

  onClose() {
    this.contentEl.empty();
  }
}

module.exports = class NoteReviewPlugin extends Plugin {
  async onload() {
    this.addRibbonIcon('brain', 'Note Review starten', () => this.startReview());
    this.addCommand({
      id: 'start-note-review',
      name: 'Review starten',
      callback: () => this.startReview(),
    });
  }

  async startReview() {
    const today = new Date().toISOString().split('T')[0];
    const due = [];

    for (const file of this.app.vault.getMarkdownFiles()) {
      const meta = this.app.metadataCache.getFileCache(file)?.frontmatter;
      if (!meta) continue;
      const dueDate = meta['sr-due'];
      if (!dueDate) continue;
      if (dueDate <= today) {
        const content = await this.app.vault.cachedRead(file);
        const body = content.replace(/^---[\s\S]*?---\n/, '').trim();
        due.push({
          path: file.path,
          basename: file.basename,
          preview: body.slice(0, 800) + (body.length > 800 ? '…' : ''),
        });
      }
    }

    if (due.length === 0) {
      new Notice('🎉 Keine Notizen fällig heute!');
      return;
    }

    new NoteReviewModal(this.app, due, this).open();
  }
};
