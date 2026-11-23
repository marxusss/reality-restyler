const customGroup = "Custom Styles";
const collapsedKey = "realityRestyle.collapsedStyleGroups";
const chevron = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg>';

// Catalog groups keep the order in which they first appear.
export function groupStyles(styles) {
  const groups = new Map();
  for (const style of styles) {
    const name = style.group || "Other";
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(style);
  }
  return [...groups].map(([name, items]) => ({name, styles: items}));
}

export function styleSearchText(style, group = style.group || "") {
  return {
    label: `${style.name} ${group}`.toLowerCase(),
    words: String(style.prompt || "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  };
}

// Every query word must appear in the name or group, or start a word of the prompt,
// so "cat" finds Cat people without matching "delicate".
export function matchesStyleSearch(text, query) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return words.every(word => text.label.includes(word) || text.words.some(promptWord => promptWord.startsWith(word)));
}

function openStorage(storage) {
  if (storage !== undefined) return storage;
  try { return window.localStorage; } catch (_) { return null; }
}

// Custom styles are persisted and merged on the PC, not in the browser.
export function mountStyles({promptInput, applyPromptNow, request, getRenderedFrame, isMirrored, fitPrompt = () => {}, closeSettings, storage}) {
  const $ = id => document.getElementById(id);
  const stylesDialog = $("stylesDialog");
  const styleSearch = $("styleSearch");
  const styleSearchEmpty = $("styleSearchEmpty");
  const customSection = $("customStyleSection");
  const store = openStorage(storage);
  const searchIndex = new WeakMap();
  let catalogLoaded = false;
  const styleEditor = $("styleEditor");
  const styleForm = $("styleForm");
  const styleName = $("styleName");
  const stylePrompt = $("stylePrompt");
  const styleCapturePreview = $("styleCapturePreview");
  const deleteStyleButton = $("deleteStyleButton");
  const styleEditorError = $("styleEditorError");

  let styleSelection = null;
  let appliedStyleSelection = { prompt: "", styles: [] };
  let editingStyleId = null;
  let customStylesSync = Promise.resolve();
  let syncedStyles = [];
  const maxStyles = 5;
  const collapsedGroups = new Set(readCollapsedGroups());

  function readCollapsedGroups() {
    try {
      const saved = JSON.parse(store?.getItem(collapsedKey) || "[]");
      return Array.isArray(saved) ? saved.filter(name => typeof name === "string") : [];
    } catch (_) {
      return [];
    }
  }

  function toggleGroup(section) {
    // A search shows every match, so groups only fold while the field is empty.
    if (styleSearch.value.trim()) return;
    const name = section.dataset.group;
    if (collapsedGroups.has(name)) collapsedGroups.delete(name);
    else collapsedGroups.add(name);
    try { store?.setItem(collapsedKey, JSON.stringify([...collapsedGroups])); } catch (_) {}
    applyStyleFilter();
  }

  function applyStyleFilter() {
    const query = styleSearch.value.trim();
    const searching = Boolean(query);
    let matches = 0;
    for (const section of stylesDialog.querySelectorAll(".style-group")) {
      const grid = section.querySelector(".style-grid");
      const cards = [...grid.children];
      let visible = 0;
      for (const card of cards) {
        const text = searchIndex.get(card);
        card.hidden = searching && !(text && matchesStyleSearch(text, query));
        if (!card.hidden) visible += 1;
      }
      matches += visible;
      section.hidden = !visible;
      const expanded = searching || !collapsedGroups.has(section.dataset.group);
      grid.hidden = !expanded;
      const header = section.querySelector(".style-group-header");
      header.setAttribute("aria-expanded", String(expanded));
      header.setAttribute("aria-disabled", String(searching));
      section.querySelector(".style-group-count").textContent = String(visible);
    }
    styleSearchEmpty.hidden = !(searching && catalogLoaded && matches === 0);
    if (!styleSearchEmpty.hidden) styleSearchEmpty.textContent = `No styles match \u201c${query}\u201d`;
  }

  function renderStyleGroups(container, styles) {
    const sections = groupStyles(styles).map(({name, styles: items}, index) => {
      const section = document.createElement("section");
      section.className = "style-group";
      section.dataset.group = name;
      section.setAttribute("aria-label", name);
      const heading = document.createElement("h3");
      const header = document.createElement("button");
      header.type = "button";
      header.className = "style-group-header";
      header.innerHTML = chevron;
      const title = document.createElement("span");
      title.className = "style-group-name";
      title.textContent = name;
      const count = document.createElement("span");
      count.className = "style-group-count";
      header.prepend(title, count);
      const grid = document.createElement("div");
      grid.className = "style-grid";
      grid.id = `styleGroup${index}`;
      header.setAttribute("aria-controls", grid.id);
      header.addEventListener("click", () => toggleGroup(section));
      heading.append(header);
      section.append(heading, grid);
      renderStyleCards(grid, items, false, name);
      return section;
    });
    container.replaceChildren(...sections);
    applyStyleFilter();
  }

  function setStyleError(element, message = "") {
    element.textContent = message;
    element.hidden = !message;
  }

  function syncCustomStyles(newStyle = null) {
    // The PC is the only persistent store and already resolves edit conflicts.
    // Serialize requests so saves cannot race with the initial load or each other.
    const operation = customStylesSync.then(async () => {
      const {styles} = await request("/styles/user", newStyle === null ? undefined : {styles: [newStyle]});
      syncedStyles = styles;
      setStyleError($("styleStorageError"));
      renderCustomStyles();
      return syncedStyles;
    }).catch(error => {
      setStyleError($("styleStorageError"), "Could not sync custom styles.");
      throw error;
    });
    customStylesSync = operation.catch(() => {});
    return operation;
  }

  function updateStyleSelection() {
    const combining = styleSelection !== null;
    $("combineStylesButton").setAttribute("aria-pressed", String(combining));
    $("addStyleButton").hidden = combining;
    $("useStylesButton").hidden = !combining;
    $("useStylesButton").disabled = !styleSelection?.length;
    for (const card of stylesDialog.querySelectorAll(".style-card")) {
      const selected = styleSelection?.includes(card.dataset.prompt) ?? false;
      if (combining) card.setAttribute("aria-pressed", String(selected));
      else card.removeAttribute("aria-pressed");
      card.disabled = styleSelection?.length === maxStyles && !selected;
    }
  }

  function setStyleSelection(selection) {
    styleSelection = selection;
    setStyleError($("styleCombineError"));
    updateStyleSelection();
  }

  function startStyleSelection() {
    return promptInput.value === appliedStyleSelection.prompt ? [...appliedStyleSelection.styles] : [];
  }

  function applyStyleSelection(prompt, styles) {
    appliedStyleSelection = { prompt, styles };
    promptInput.value = prompt;
    fitPrompt();
    applyPromptNow();
    stylesDialog.close();
  }

  async function useStyleSelection() {
    const selection = styleSelection;
    if (!selection?.length) return;
    $("useStylesButton").disabled = true;
    setStyleError($("styleCombineError"));
    try {
      const { prompt } = await request("/styles/combine", { prompts: selection });
      if (stylesDialog.open && styleSelection === selection) applyStyleSelection(prompt, selection);
    } catch (error) {
      if (styleSelection === selection) setStyleError($("styleCombineError"), error.message);
    } finally {
      if (styleSelection === selection) updateStyleSelection();
    }
  }

  function renderStyleCards(container, styles, editable = false, group = "") {
    const cards = styles.map(style => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "style-card";
      button.dataset.prompt = style.prompt;
      button.title = style.name;
      const thumbnail = document.createElement("span");
      thumbnail.className = "style-thumbnail";
      if (style.thumbnail) {
        const image = document.createElement("img");
        image.alt = "";
        image.loading = "lazy";
        image.decoding = "async";
        image.src = style.thumbnail;
        thumbnail.append(image);
      }
      const label = document.createElement("span");
      label.className = "style-name";
      label.textContent = style.name;
      thumbnail.append(label);
      button.append(thumbnail);
      button.addEventListener("click", event => {
        if (styleSelection === null && !event.shiftKey) {
          applyStyleSelection(style.prompt, [style.prompt]);
          return;
        }
        const selected = styleSelection ?? startStyleSelection();
        if (selected.includes(style.prompt)) {
          setStyleSelection(selected.filter(prompt => prompt !== style.prompt));
        } else if (selected.length < maxStyles) {
          setStyleSelection([...selected, style.prompt]);
        } else {
          setStyleSelection(selected);
        }
      });
      if (!editable) {
        searchIndex.set(button, styleSearchText(style, group));
        return button;
      }
      const card = document.createElement("div");
      card.className = "custom-style-card";
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "style-edit-button";
      edit.setAttribute("aria-label", `Edit ${style.name}`);
      edit.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 5 4 4M4 20l4.5-1 10.2-10.2a2.1 2.1 0 0 0-3-3L5.5 16 4 20Z"/></svg>';
      edit.addEventListener("click", () => openStyleEditor(style));
      card.append(button, edit);
      searchIndex.set(card, styleSearchText(style, group));
      return card;
    });
    container.replaceChildren(...cards);
    updateStyleSelection();
  }

  function renderCustomStyles() {
    const styles = syncedStyles.filter(style => !style.deleted);
    renderStyleCards($("customStyles"), styles, true, customGroup);
    applyStyleFilter();
  }

  async function openStyles() {
    if (stylesDialog.open) {
      stylesDialog.close();
      return;
    }
    const presetStyles = $("presetStyles");
    const catalogError = $("catalogError");
    setStyleSelection(null);
    renderCustomStyles();
    closeSettings();
    stylesDialog.show();
    styleSearch.value = "";
    applyStyleFilter();
    for (const button of [$("stylesButton"), $("quickStylesButton")]) {
      button.setAttribute("aria-expanded", "true");
    }
    void syncCustomStyles().catch(() => {});
    if (presetStyles.hasChildNodes()) return;
    setStyleError(catalogError);
    try {
      const response = await fetch("/styles/catalog.json");
      if (!response.ok) throw new Error();
      const styles = await response.json();
      catalogLoaded = true;
      renderStyleGroups(presetStyles, styles);
    } catch (_) {
      setStyleError(catalogError, "Could not load styles.");
    }
  }

  function openStyleEditor(style = null) {
    editingStyleId = style?.id || null;
    deleteStyleButton.hidden = !editingStyleId;
    styleForm.reset();
    $("styleEditorTitle").textContent = style ? "Edit Style" : "Add Style";
    styleName.value = style?.name || "";
    stylePrompt.value = style?.prompt ?? promptInput.value;
    if (style?.thumbnail) {
      styleCapturePreview.src = style.thumbnail;
      styleCapturePreview.hidden = false;
    } else {
      styleCapturePreview.removeAttribute("src");
      styleCapturePreview.hidden = true;
    }
    setStyleError(styleEditorError);
    styleEditor.showModal();
  }

  function captureStyle() {
    setStyleError(styleEditorError);
    const {frame, width, height} = getRenderedFrame() || {};
    if (!width || !height) {
      setStyleError(styleEditorError, "No AI frame available to capture.");
      return;
    }
    try {
      const thumbnail = document.createElement("canvas");
      const aspectRatio = 8 / 5;
      let sourceX = 0;
      let sourceY = 0;
      let sourceWidth = width;
      let sourceHeight = height;
      if (width / height > aspectRatio) {
        sourceWidth = height * aspectRatio;
        sourceX = (width - sourceWidth) / 2;
      } else {
        sourceHeight = width / aspectRatio;
        sourceY = (height - sourceHeight) / 2;
      }
      const scale = Math.min(1, 320 / sourceWidth, 200 / sourceHeight);
      thumbnail.width = Math.max(1, Math.round(sourceWidth * scale));
      thumbnail.height = Math.max(1, Math.round(sourceHeight * scale));
      const context = thumbnail.getContext("2d", { alpha: false });
      if (isMirrored()) {
        context.translate(thumbnail.width, 0);
        context.scale(-1, 1);
      }
      context.drawImage(frame, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, thumbnail.width, thumbnail.height);
      styleCapturePreview.src = thumbnail.toDataURL("image/webp", 0.78);
      styleCapturePreview.hidden = false;
    } catch (_) {
      setStyleError(styleEditorError, "Could not capture the AI frame.");
    }
  }

  async function deleteStyle() {
    const previous = editingStyleId ? syncedStyles.find(item => item.id === editingStyleId && !item.deleted) : null;
    if (!previous || !window.confirm(`Delete "${previous.name}"? This removes it from synced devices.`)) return;
    deleteStyleButton.disabled = true;
    try {
      await syncCustomStyles({
        id: previous.id,
        deleted: true,
        updatedAt: Math.max(Date.now(), previous.updatedAt + 1)
      });
      styleEditor.close();
    } catch (_) {
      setStyleError(styleEditorError, "Could not delete the style.");
    } finally {
      deleteStyleButton.disabled = false;
    }
  }

  async function saveStyle(event) {
    event.preventDefault();
    const save = styleForm.querySelector('button[type="submit"]');
    if (save.disabled) return;
    const name = styleName.value.trim();
    const prompt = stylePrompt.value;
    if (!name || !prompt.trim()) {
      setStyleError(styleEditorError, "Enter a name and prompt.");
      return;
    }
    const previous = editingStyleId ? syncedStyles.find(item => item.id === editingStyleId) : null;
    const style = {
      id: editingStyleId || (crypto.randomUUID ? crypto.randomUUID() : `style-${Date.now()}-${Math.random().toString(16).slice(2)}`),
      name,
      prompt,
      thumbnail: styleCapturePreview.getAttribute("src"),
      updatedAt: Math.max(Date.now(), (previous?.updatedAt || 0) + 1)
    };
    editingStyleId = style.id;
    save.disabled = true;
    try {
      await syncCustomStyles(style);
    } catch (_) {
      setStyleError(styleEditorError, "Could not save the style.");
      return;
    } finally {
      save.disabled = false;
    }
    if (previous && styleSelection?.includes(previous.prompt)) {
      styleSelection = styleSelection.map(selected => selected === previous.prompt ? prompt : selected);
    }
    styleEditor.close();
    renderCustomStyles();
    const visibleIndex = syncedStyles.filter(item => !item.deleted).findIndex(item => item.id === style.id);
    const savedCard = $("customStyles").querySelectorAll(".custom-style-card")[visibleIndex];
    savedCard?.querySelector(".style-edit-button")?.focus();
  }


  const updateStylesExpanded = () => {
    const expanded = String(stylesDialog.open);
    for (const button of [$("stylesButton"), $("quickStylesButton")]) {
      button.setAttribute("aria-expanded", expanded);
    }
  };
  stylesDialog.addEventListener("close", () => {
    styleSearch.blur();
    updateStylesExpanded();
  });
  customSection.querySelector(".style-group-header").addEventListener("click", () => toggleGroup(customSection));
  styleSearch.addEventListener("input", () => {
    applyStyleFilter();
    $("styleList").scrollTop = 0;
  });
  styleSearch.addEventListener("keydown", event => {
    // Search runs as you type; Enter only puts the keyboard away so the results show.
    if (event.key === "Enter") {
      event.preventDefault();
      styleSearch.blur();
    }
  });
  $("stylesButton").addEventListener("click", () => void openStyles());
  $("quickStylesButton").addEventListener("click", () => void openStyles());
  $("combineStylesButton").addEventListener("click", () => setStyleSelection(styleSelection === null ? startStyleSelection() : null));
  $("useStylesButton").addEventListener("click", () => void useStyleSelection());
  $("closeStylesButton").addEventListener("click", () => stylesDialog.close());
  $("addStyleButton").addEventListener("click", () => openStyleEditor());
  $("closeStyleEditorButton").addEventListener("click", () => styleEditor.close());
  $("captureStyleButton").addEventListener("click", captureStyle);
  deleteStyleButton.addEventListener("click", () => void deleteStyle());
  styleForm.addEventListener("submit", event => { void saveStyle(event); });
  void syncCustomStyles().catch(() => {});
}
