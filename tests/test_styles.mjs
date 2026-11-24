import {test} from "node:test";
import assert from "node:assert/strict";
import {mountStyles} from "../src/web/styles.js";

function fakeElement() {
  return {
    dataset: {},
    events: {},
    children: [],
    hidden: false,
    disabled: false,
    value: "",
    addEventListener(name, handler) { this.events[name] = handler; },
    setAttribute() {},
    removeAttribute() {},
    append(...children) { this.children.push(...children); },
    prepend(...children) { this.children.unshift(...children); },
    replaceChildren(...children) { this.children = children; },
    hasChildNodes() { return this.children.length > 0; },
    querySelector(selector) { return this.querySelectorAll(selector)[0] || fakeElement(); },
    querySelectorAll(selector) {
      const name = selector.slice(1);
      const found = [];
      const walk = node => {
        for (const child of node.children || []) {
          if (String(child.className).split(/\s+/).includes(name)) found.push(child);
          walk(child);
        }
      };
      walk(this);
      return found;
    },
    focus() { this.focused = true; },
    showModal() { this.open = true; },
    show() { this.open = true; },
    close() { this.open = false; },
    reset() {},
    getAttribute() { return null; }
  };
}

test("custom styles load and save through the PC", async () => {
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  const previousFetch = globalThis.fetch;
  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) elements.set(id, fakeElement());
    return elements.get(id);
  };
  globalThis.document = {getElementById: get, createElement: fakeElement};
  const customSection = get("customStyleSection");
  customSection.className = "style-group";
  customSection.dataset.group = "Custom Styles";
  const customHeader = fakeElement();
  customHeader.className = "style-group-header";
  customHeader.append(Object.assign(fakeElement(), {className: "style-group-count"}));
  get("customStyles").className = "style-grid";
  customSection.append(customHeader, get("customStyles"));
  get("customStyleGroups").className = "style-groups";
  get("presetStyles").className = "style-groups";
  get("stylesDialog").append(get("styleSearch"), get("customStyleGroups"), customSection, get("presetStyles"), get("styleSearchEmpty"));
  get("styleList").append(get("addCustomSectionButton"), get("customStyleGroups"), customSection, get("presetStyles"));
  const requests = [];
  // A prior deletion remains in the host store but is not rendered as a card.
  let stored = [{id: "deleted-first", deleted: true, updatedAt: Date.now() + 100000}];
  let sections = [];
  globalThis.window = {prompt: () => "Favorites"};
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => [{id: "oil", name: "Impasto oil", group: "Painting", prompt: "oil", thumbnail: null}]
  });
  try {
    mountStyles({
      promptInput: get("promptInput"),
      applyPromptNow() {},
      getRenderedFrame() { return null; },
      isMirrored() { return false; },
      request: async (path, body) => {
        assert.equal(path, "/styles/user");
        requests.push(body ? {method: "POST", body} : {method: "GET"});
        if (body) {
          const merged = new Map(stored.map(style => [style.id, style]));
          for (const style of body.styles) merged.set(style.id, style);
          stored = [...merged.values()];
          if (Array.isArray(body.sections)) sections = [...new Set([...sections, ...body.sections])];
        }
        return {styles: stored, sections};
      },
      closeSettings() {}
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(requests, [{method: "GET"}]);
    await get("addStyleButton").events.click();
    get("styleName").value = "Example";
    get("stylePrompt").value = "watercolor";
    get("styleForm").events.submit({preventDefault() {}});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(requests.length, 2);
    assert.equal(requests[1].method, "POST");
    assert.equal(requests[1].body.styles.length, 1);
    assert.equal(requests[1].body.styles[0].name, "Example");
    assert.equal(stored.length, 2);
    assert.equal(get("customStyles").children.length, 1);
    assert.equal(get("customStyles").children[0].children[1].focused, true);

    get("quickStylesButton").events.click();
    await new Promise(resolve => setImmediate(resolve));
    get("addCustomSectionButton").events.click();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(sections, ["Favorites"]);
    assert.equal(get("customStyleGroups").children[0].dataset.group, "Favorites");
    assert.deepEqual(requests[3].body, {styles: [], sections: ["Favorites"]});

    await get("customStyles").children[0].children[1].events.click();
    assert.equal(get("styleEditorTitle").textContent, "Edit Style");
    assert.ok(get("styleSection").children.some(option => option.value === "Painting"));
    get("styleSection").value = "Painting";
    get("stylePrompt").value = "updated watercolor";
    get("styleForm").events.submit({preventDefault() {}});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(stored.find(style => style.name === "Example").group, "Painting");
    assert.equal(get("customStyleGroups").children.some(group => group.dataset.group === "Painting"), true);
    assert.equal(get("presetStyles").children[0].dataset.group, "Painting");
    assert.equal(get("customStyleGroups").children[0].dataset.group, "Favorites");
    const paintingUserGroup = get("customStyleGroups").children.find(group => group.dataset.group === "Painting");
    get("styleSearch").value = "painting";
    get("styleSearch").events.input();
    assert.equal(paintingUserGroup.hidden, false);
    assert.equal(paintingUserGroup.querySelector(".style-grid").children[0].hidden, false);

    get("styleSearch").value = "";
    get("styleSearch").events.input();
    await paintingUserGroup.querySelector(".style-grid").children[0].children[1].events.click();
    get("styleSection").value = "Favorites";
    get("styleForm").events.submit({preventDefault() {}});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(stored.find(style => style.name === "Example").group, "Favorites");
    assert.equal(get("customStyleGroups").children[0].dataset.group, "Favorites");
    assert.equal(get("customStyleGroups").children[0].querySelector(".style-grid").children.length, 1);
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = previousFetch;
  }
});
