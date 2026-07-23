import type { Api, Model } from "@earendil-works/pi-ai";
import { DynamicBorder, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import {
  Container,
  type Focusable,
  fuzzyFilter,
  Input,
  type KeybindingsManager,
  type SelectItem,
  SelectList,
  Text,
} from "@earendil-works/pi-tui";
import { modelKey } from "./model.js";

export const MODEL_SELECTOR_VISIBLE_ROWS = 8;

function modelSearchText(model: Model<Api>): string {
  return `${modelKey(model)} ${model.provider} ${model.id} ${model.name ?? ""}`;
}

export function fuzzyFilterModels(models: Model<Api>[], query: string): Model<Api>[] {
  return fuzzyFilter(models, query, modelSearchText);
}

export function fuzzyFilterModelKeys(keys: string[], query: string): string[] {
  return fuzzyFilter(keys, query, (key) => key);
}

export class CommitModelSelector extends Container implements Focusable {
  private readonly models: Model<Api>[];
  private readonly currentModelKey: string | undefined;
  private readonly theme: Theme;
  private readonly keybindings: KeybindingsManager;
  private readonly onSelect: (key: string) => void;
  private readonly onCancel: () => void;
  private readonly requestRender: () => void;
  private readonly searchInput: Input;
  private readonly listContainer: Container;
  private readonly title: Text;
  private readonly help: Text;
  private filteredModels: Model<Api>[];
  private selectList!: SelectList;
  private selectedIndex: number;
  private _focused = false;

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.searchInput.focused = value;
  }

  constructor(
    models: Model<Api>[],
    currentModelKey: string | undefined,
    theme: Theme,
    keybindings: KeybindingsManager,
    onSelect: (key: string) => void,
    onCancel: () => void,
    requestRender: () => void,
  ) {
    super();
    this.models = models;
    this.currentModelKey = currentModelKey;
    this.theme = theme;
    this.keybindings = keybindings;
    this.onSelect = onSelect;
    this.onCancel = onCancel;
    this.requestRender = requestRender;
    this.filteredModels = models;

    const currentIndex = currentModelKey
      ? models.findIndex((model) => modelKey(model) === currentModelKey)
      : -1;
    this.selectedIndex = currentIndex >= 0 ? currentIndex : 0;

    this.title = new Text(this.titleText(), 1, 0);
    this.searchInput = new Input();
    this.listContainer = new Container();
    this.help = new Text(this.helpText(), 1, 0);

    this.addChild(new DynamicBorder((text: string) => this.theme.fg("accent", text)));
    this.addChild(this.title);
    this.addChild(this.searchInput);
    this.addChild(this.listContainer);
    this.addChild(this.help);
    this.addChild(new DynamicBorder((text: string) => this.theme.fg("accent", text)));

    this.rebuildList();
  }

  private titleText(): string {
    return this.theme.fg("accent", this.theme.bold("Select commit-message model — type to search"));
  }

  private helpText(): string {
    return this.theme.fg("dim", "↑↓ navigate • enter select • esc cancel");
  }

  private description(model: Model<Api>): string | undefined {
    const details: string[] = [];
    if (model.name && model.name !== model.id) details.push(model.name);
    if (modelKey(model) === this.currentModelKey) details.push("current");
    return details.length ? details.join(" • ") : undefined;
  }

  private items(): SelectItem[] {
    return this.filteredModels.map((model) => ({
      value: modelKey(model),
      label: modelKey(model),
      description: this.description(model),
    }));
  }

  private rebuildList(): void {
    this.selectList = new SelectList(this.items(), MODEL_SELECTOR_VISIBLE_ROWS, {
      selectedPrefix: (text) => this.theme.fg("accent", text),
      selectedText: (text) => this.theme.fg("accent", text),
      description: (text) => this.theme.fg("muted", text),
      scrollInfo: (text) => this.theme.fg("dim", text),
      noMatch: () => this.theme.fg("warning", "  No matching models"),
    }, {
      minPrimaryColumnWidth: 32,
      maxPrimaryColumnWidth: 56,
    });
    this.selectList.setSelectedIndex(this.selectedIndex);
    this.listContainer.clear();
    this.listContainer.addChild(this.selectList);
  }

  private moveSelection(delta: number): void {
    const count = this.filteredModels.length;
    if (count === 0) return;
    this.selectedIndex = (this.selectedIndex + delta + count) % count;
    this.selectList.setSelectedIndex(this.selectedIndex);
  }

  private pageSelection(delta: number): void {
    if (this.filteredModels.length === 0) return;
    this.selectedIndex = Math.max(
      0,
      Math.min(this.filteredModels.length - 1, this.selectedIndex + delta),
    );
    this.selectList.setSelectedIndex(this.selectedIndex);
  }

  private updateFilter(): void {
    this.filteredModels = fuzzyFilterModels(this.models, this.searchInput.getValue());
    this.selectedIndex = 0;
    this.rebuildList();
  }

  handleInput(data: string): void {
    let changed = false;

    if (this.keybindings.matches(data, "tui.select.up")) {
      this.moveSelection(-1);
      changed = true;
    } else if (this.keybindings.matches(data, "tui.select.down")) {
      this.moveSelection(1);
      changed = true;
    } else if (this.keybindings.matches(data, "tui.select.pageUp")) {
      this.pageSelection(-MODEL_SELECTOR_VISIBLE_ROWS);
      changed = true;
    } else if (this.keybindings.matches(data, "tui.select.pageDown")) {
      this.pageSelection(MODEL_SELECTOR_VISIBLE_ROWS);
      changed = true;
    } else if (this.keybindings.matches(data, "tui.select.confirm")) {
      const selected = this.filteredModels[this.selectedIndex];
      if (selected) this.onSelect(modelKey(selected));
    } else if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.onCancel();
    } else {
      const previousQuery = this.searchInput.getValue();
      this.searchInput.handleInput(data);
      if (this.searchInput.getValue() !== previousQuery) {
        this.updateFilter();
        changed = true;
      }
    }

    if (changed) this.requestRender();
  }

  getSelectedModelKey(): string | undefined {
    const selected = this.filteredModels[this.selectedIndex];
    return selected ? modelKey(selected) : undefined;
  }

  getSearchQuery(): string {
    return this.searchInput.getValue();
  }

  getMatchCount(): number {
    return this.filteredModels.length;
  }

  override invalidate(): void {
    super.invalidate();
    this.title.setText(this.titleText());
    this.help.setText(this.helpText());
    this.rebuildList();
  }
}

export async function showCommitModelSelector(
  ctx: ExtensionContext,
  models: Model<Api>[],
  currentModelKey?: string,
): Promise<string | undefined> {
  return ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) =>
    new CommitModelSelector(
      models,
      currentModelKey,
      theme,
      keybindings,
      done,
      () => done(undefined),
      () => tui.requestRender(),
    ));
}
