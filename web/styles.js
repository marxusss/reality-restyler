// Own the style catalog, editor, selection state and event handlers.
export function mountStyles({promptInput, applyPromptNow, request, getRenderedFrame, isMirrored}) {
  const $ = id => document.getElementById(id);
  const stylesDialog = $("stylesDialog");
  const styleEditor = $("styleEditor");
  const styleForm = $("styleForm");
  const styleName = $("styleName");
  const stylePrompt = $("stylePrompt");
  const styleCapturePreview = $("styleCapturePreview");
  const styleEditorError = $("styleEditorError");
  const customStyleStorageKey = "reality-restyle-custom-styles";

  let styleSelection = null;
  let appliedStyleSelection = { prompt: "", styles: [] };
  let editingStyleId = null;
  let customStylesSync = Promise.resolve();
  const maxStyles = 5;

  function setStyleError(element, message = "") {
    element.textContent = message;
    element.hidden = !message;
  }

  function legacyStyleId(style) {
    let value = 2166136261;
    for (const byte of new TextEncoder().encode(`${style.name}\0${style.prompt}`)) {
      value = Math.imul(value ^ byte, 16777619) >>> 0;
    }
    return `legacy-${value.toString(16).padStart(8, "0")}`;
  }

  function normalizeStyles(styles) {
    if (!Array.isArray(styles)) return [];
    return styles.filter(style => style && typeof style.name === "string" && style.name.trim() &&
      typeof style.prompt === "string" && style.prompt.trim()).map(style => ({
      id: typeof style.id === "string" && style.id ? style.id : legacyStyleId(style),
      name: style.name.trim(),
      prompt: style.prompt,
      thumbnail: typeof style.thumbnail === "string" && style.thumbnail.startsWith("data:image/webp;base64,") ? style.thumbnail : null,
      updatedAt: Number.isFinite(style.updatedAt) ? Math.max(0, Math.trunc(style.updatedAt)) : 0
    }));
  }

  function customStyles() {
    try {
      return normalizeStyles(JSON.parse(localStorage.getItem(customStyleStorageKey) || "[]"));
    } catch (_) {}
    return [];
  }

  function saveLocalCustomStyles(styles) {
    try {
      localStorage.setItem(customStyleStorageKey, JSON.stringify(styles));
      return true;
    } catch (_) {
      return false;
    }
  }

  function mergeCustomStyles(remote, local) {
    const merged = new Map();
    for (const style of [...normalizeStyles(remote), ...normalizeStyles(local)]) {
      const previous = merged.get(style.id);
      if (!previous || style.updatedAt > previous.updatedAt) merged.set(style.id, style);
    }
    return [...merged.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  function sameCustomStyles(left, right) {
    const stable = styles => normalizeStyles(styles)
      .sort((a, b) => a.id.localeCompare(b.id));
    return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
  }

  function syncCustomStyles(localOverride = null) {
    const operation = customStylesSync.then(async () => {
      const local = normalizeStyles(localOverride || customStyles());
      const remote = normalizeStyles((await request("/styles/user")).styles);
      let styles = mergeCustomStyles(remote, local);
      saveLocalCustomStyles(styles);
      if (!sameCustomStyles(styles, remote)) {
        const saved = await request("/styles/user", { styles });
        styles = mergeCustomStyles(saved.styles, styles);
        saveLocalCustomStyles(styles);
      }
      setStyleError($("styleStorageError"));
      renderCustomStyles();
      return styles;
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

  function renderStyleCards(container, styles, editable = false) {
    const cards = styles.map((style, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "style-card";
      button.dataset.prompt = style.prompt;
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
      label.textContent = style.name;
      button.append(thumbnail, label);
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
      if (!editable) return button;
      const card = document.createElement("div");
      card.className = "custom-style-card";
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "style-edit-button";
      edit.setAttribute("aria-label", `Edit ${style.name}`);
      edit.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 5 4 4M4 20l4.5-1 10.2-10.2a2.1 2.1 0 0 0-3-3L5.5 16 4 20Z"/></svg>';
      edit.addEventListener("click", () => openStyleEditor(style));
      card.append(button, edit);
      return card;
    });
    container.replaceChildren(...cards);
    updateStyleSelection();
  }

  function renderCustomStyles() {
    const styles = customStyles();
    $("customStyleSection").hidden = !styles.length;
    renderStyleCards($("customStyles"), styles, true);
  }

  async function openStyles() {
    const presetStyles = $("presetStyles");
    const catalogError = $("catalogError");
    setStyleSelection(null);
    renderCustomStyles();
    stylesDialog.showModal();
    void syncCustomStyles().catch(() => {});
    if (presetStyles.hasChildNodes()) return;
    setStyleError(catalogError);
    try {
      const response = await fetch("/styles/catalog.json");
      if (!response.ok) throw new Error();
      renderStyleCards(presetStyles, await response.json());
    } catch (_) {
      setStyleError(catalogError, "Could not load styles.");
    }
  }

  function openStyleEditor(style = null) {
    editingStyleId = style?.id || null;
    styleForm.reset();
    $("styleEditorTitle").textContent = style ? "Edit style" : "Add style";
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
      const scale = Math.min(1, 320 / Math.max(width, height));
      thumbnail.width = Math.max(1, Math.round(width * scale));
      thumbnail.height = Math.max(1, Math.round(height * scale));
      const context = thumbnail.getContext("2d", { alpha: false });
      if (isMirrored()) {
        context.translate(thumbnail.width, 0);
        context.scale(-1, 1);
      }
      context.drawImage(frame, 0, 0, thumbnail.width, thumbnail.height);
      styleCapturePreview.src = thumbnail.toDataURL("image/webp", 0.78);
      styleCapturePreview.hidden = false;
    } catch (_) {
      setStyleError(styleEditorError, "Could not capture the AI frame.");
    }
  }

  async function saveStyle(event) {
    event.preventDefault();
    const name = styleName.value.trim();
    const prompt = stylePrompt.value;
    if (!name || !prompt.trim()) {
      setStyleError(styleEditorError, "Enter a name and prompt.");
      return;
    }
    const styles = customStyles();
    const savedIndex = editingStyleId ? styles.findIndex(item => item.id === editingStyleId) : -1;
    const previous = savedIndex >= 0 ? styles[savedIndex] : null;
    const style = {
      id: editingStyleId || (crypto.randomUUID ? crypto.randomUUID() : `style-${Date.now()}-${Math.random().toString(16).slice(2)}`),
      name,
      prompt,
      thumbnail: styleCapturePreview.getAttribute("src"),
      updatedAt: Math.max(Date.now(), (previous?.updatedAt || 0) + 1)
    };
    if (savedIndex < 0) styles.unshift(style);
    else styles[savedIndex] = style;
    editingStyleId = style.id;
    if (previous && styleSelection?.includes(previous.prompt)) {
      styleSelection = styleSelection.map(selected => selected === previous.prompt ? prompt : selected);
    }
    saveLocalCustomStyles(styles);
    renderCustomStyles();
    try {
      await syncCustomStyles(styles);
    } catch (_) {
      setStyleError(styleEditorError, "Could not save the style.");
      return;
    }
    styleEditor.close();
    renderCustomStyles();
    const finalIndex = customStyles().findIndex(item => item.id === style.id);
    const savedCard = $("customStyles").querySelectorAll(".custom-style-card")[finalIndex];
    savedCard?.querySelector(finalIndex < 0 ? ".style-card" : ".style-edit-button")?.focus();
  }


  $("stylesButton").addEventListener("click", () => void openStyles());
  $("combineStylesButton").addEventListener("click", () => setStyleSelection(styleSelection === null ? startStyleSelection() : null));
  $("useStylesButton").addEventListener("click", () => void useStyleSelection());
  $("closeStylesButton").addEventListener("click", () => stylesDialog.close());
  $("addStyleButton").addEventListener("click", () => openStyleEditor());
  $("closeStyleEditorButton").addEventListener("click", () => styleEditor.close());
  $("captureStyleButton").addEventListener("click", captureStyle);
  styleForm.addEventListener("submit", event => { void saveStyle(event); });
  void syncCustomStyles().catch(() => {});
}
