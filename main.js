const { Plugin, Modal, Notice, PluginSettingTab, Setting } = require('obsidian');

const DEFAULT_SETTINGS = {
  reviewTags: ['review'],
};

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
  return {
    repetitions,
    easeFactor,
    interval,
    nextReview: nextReview.toISOString().split('T')[0],
  };
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

    this.keyHandler = (e) => {
      if (!e.metaKey) return;
      const map = { '1': 1, '2': 2, '3': 4, '4': 5 };
      const quality = map[e.key];
      if (!quality) return;
      e.preventDefault();
      if (this.current < this.notes.length) {
        this.rate(this.notes[this.current], quality);
      }
    };
    document.addEventListener('keydown', this.keyHandler);
  }

  render() {
    const { contentEl } = this;
    contentEl.empty();

    if (this.current >= this.notes.length) {
      const container = contentEl.createEl('div', { cls: 'note-review-container' });
      const empty = container.createEl('div', { cls: 'note-review-empty' });
      empty.createEl('div', { cls: 'checkmark', text: '✅' });
      empty.createEl('p').createEl('strong', { text: 'Alle Notizen für heute erledigt!' });
      empty.createEl('p', { text: 'Gut gemacht.' });
      return;
    }

    const note = this.notes[this.current];
    const container = contentEl.createEl('div', { cls: 'note-review-container' });

    const header = container.createEl('div', { cls: 'note-review-header' });
    header.createEl('h2', { text: 'Notiz-Review' });
    header.createEl('span', { cls: 'note-review-counter', text: `${this.current + 1} / ${this.notes.length}` });

    const content = container.createEl('div', { cls: 'note-review-content' });
    content.createEl('div', { cls: 'note-review-title', text: note.basename });
    content.createEl('div', { cls: 'note-review-body', text: note.preview });

    const buttons = container.createEl('div', { cls: 'note-review-buttons' });
    const ratings = [
      { label: '🔁 Nochmal  ⌘1', cls: 'btn-again', quality: 1 },
      { label: '😓 Schwer   ⌘2', cls: 'btn-hard',  quality: 2 },
      { label: '👍 Gut      ⌘3', cls: 'btn-good',  quality: 4 },
      { label: '⚡ Leicht   ⌘4', cls: 'btn-easy',  quality: 5 },
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
    document.removeEventListener('keydown', this.keyHandler);
    this.contentEl.empty();
  }
}

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
  }
}

module.exports = class NoteReviewPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.addSettingTab(new NoteReviewSettingTab(this.app, this));

    this.addRibbonIcon('brain', 'Note Review starten', () => this.startReview());

    this.addCommand({
      id: 'start-note-review',
      name: 'Review starten',
      callback: () => this.startReview(),
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
    const today = new Date().toISOString().split('T')[0];
    const tags = this.settings.reviewTags.map(t => t.toLowerCase());
    const due = [];

    for (const file of this.app.vault.getMarkdownFiles()) {
      const cache = this.app.metadataCache.getFileCache(file);
      const meta = cache?.frontmatter;

      // Tags aus beiden Quellen sammeln: inline #tags und Frontmatter tags-Liste
      const inlineTags = (cache?.tags || []).map(t => t.tag.replace(/^#/, '').toLowerCase());
      const frontmatterTags = Array.isArray(meta?.tags)
        ? meta.tags.map(t => String(t).replace(/^#/, '').toLowerCase())
        : [];
      const fileTags = [...new Set([...inlineTags, ...frontmatterTags])];

      const hasReviewTag = tags.some(t => fileTags.includes(t));

      if (hasReviewTag && !meta?.['sr-due']) {
        await this.app.fileManager.processFrontMatter(file, fm => {
          fm['sr-due'] = today;
        });
      }

      const updatedMeta = this.app.metadataCache.getFileCache(file)?.frontmatter;
      const dueDate = updatedMeta?.['sr-due'];
      if (!dueDate || dueDate > today) continue;

      const content = await this.app.vault.cachedRead(file);
      const body = content.replace(/^---[\s\S]*?---\n/, '').trim();
      due.push({
        path: file.path,
        basename: file.basename,
        preview: body.slice(0, 800) + (body.length > 800 ? '…' : ''),
      });
    }

    if (due.length === 0) {
      new Notice('🎉 Keine Notizen fällig heute!');
      return;
    }

    new NoteReviewModal(this.app, due, this).open();
  }
};
