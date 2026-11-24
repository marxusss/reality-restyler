import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {groupStyles, matchesStyleSearch, mountStyles, styleSearchText} from "../src/web/styles.js";

const catalog = [
  {id: "oil", name: "Impasto oil", group: "Painting", prompt: "Thick oil paint with visible knife strokes, keep scene intact", thumbnail: "/styles/oil.webp"},
  {id: "fresco", name: "Fresco", group: "Painting", prompt: "Chalky plaster pigments, keep scene intact", thumbnail: "/styles/fresco.webp"},
  {id: "porcelain", name: "Glazed porcelain", group: "Craft & texture", prompt: "Glossy porcelain with delicate blue patterns, keep scene intact", thumbnail: "/styles/porcelain.webp"},
  {id: "cat-people", name: "Cat people", group: "Strange", prompt: "Every person has the head of a cat, keep scene intact", thumbnail: "/styles/cat-people.webp"},
  {id: "deep-sea", name: "Bioluminescent deep sea", group: "Strange", prompt: "Dark water and drifting jellyfish, keep scene intact", thumbnail: "/styles/deep-sea.webp"}
];

// Just enough of the DOM for styles.js: a tree of elements found by id or by class.
function element(tag = "div") {
  const listeners = {};
  const attributes = {};
  return {
    tagName: tag, id: "", className: "", dataset: {}, children: [], hidden: false, disabled: false,
    value: "", textContent: "", innerHTML: "", scrollTop: 0, open: false,
    addEventListener(name, handler) { listeners[name] = handler; },
    emit(name, event = {}) { return listeners[name]?.(event); },
    click(event = {}) { return listeners.click?.(event); },
    setAttribute(name, value) { attributes[name] = String(value); },
    getAttribute(name) { return attributes[name] ?? null; },
    removeAttribute(name) { delete attributes[name]; },
    append(...nodes) { this.children.push(...nodes); },
    prepend(...nodes) { this.children.unshift(...nodes); },
    replaceChildren(...nodes) { this.children = nodes; },
    hasChildNodes() { return this.children.length > 0; },
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
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
    show() { this.open = true; },
    showModal() { this.open = true; },
    close() { this.open = false; listeners.close?.(); },
    blur() { this.blurred = true; },
    focus() {},
    reset() {}
  };
}

function group(name, gridId) {
  const section = element("section");
  section.className = "style-group";
  section.dataset.group = name;
  const header = element("button");
  header.className = "style-group-header";
  const count = element("span");
  count.className = "style-group-count";
  header.append(count);
  const heading = element("h3");
  heading.append(header);
  const grid = element();
  grid.className = "style-grid";
  grid.id = gridId;
  section.append(heading, grid);
  return {section, header, grid};
}

function mountDialog(storage) {
  const ids = new Map();
  const get = id => {
    if (!ids.has(id)) {
      const node = element();
      node.id = id;
      ids.set(id, node);
    }
    return ids.get(id);
  };
  const custom = group("Custom Styles", "customStyles");
  ids.set("customStyleSection", custom.section);
  ids.set("customStyles", custom.grid);
  get("stylesDialog").append(get("styleSearch"), custom.section, get("presetStyles"), get("styleSearchEmpty"));
  const applied = [];
  globalThis.document = {getElementById: get, createElement: element};
  globalThis.fetch = async () => ({ok: true, json: async () => catalog});
  const promptInput = get("promptInput");
  mountStyles({
    promptInput,
    applyPromptNow() { applied.push(promptInput.value); },
    request: async () => ({styles: []}),
    getRenderedFrame() { return null; },
    isMirrored() { return false; },
    closeSettings() {},
    storage
  });
  return {get, applied};
}

function memoryStorage() {
  const values = new Map();
  return {getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value))};
}

async function withDialog(storage, run) {
  const previous = {document: globalThis.document, fetch: globalThis.fetch};
  try {
    const dialog = mountDialog(storage);
    await dialog.get("quickStylesButton").click();
    await new Promise(resolve => setImmediate(resolve));
    const sections = () => dialog.get("presetStyles").children;
    const byGroup = name => sections().find(section => section.dataset.group === name);
    const visibleCards = () => sections().filter(section => !section.hidden)
      .flatMap(section => section.querySelector(".style-grid").children.filter(card => !card.hidden).map(card => card.title));
    const search = value => {
      dialog.get("styleSearch").value = value;
      dialog.get("styleSearch").emit("input");
    };
    await run({...dialog, sections, byGroup, visibleCards, search});
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[name];
      else globalThis[name] = value;
    }
  }
}

test("styles group in catalog order and search matches name, group and prompt words", () => {
  assert.deepEqual(groupStyles(catalog).map(({name, styles}) => [name, styles.length]),
    [["Painting", 2], ["Craft & texture", 1], ["Strange", 2]]);
  const text = Object.fromEntries(catalog.map(style => [style.id, styleSearchText(style)]));
  assert.ok(matchesStyleSearch(text["cat-people"], "cat"));
  // "cat" starts no word of the porcelain prompt, though "delicate" contains it.
  assert.ok(!matchesStyleSearch(text.porcelain, "cat"));
  assert.ok(matchesStyleSearch(text["deep-sea"], "jelly"));
  assert.ok(matchesStyleSearch(text.porcelain, "craft"));
  assert.ok(matchesStyleSearch(text.oil, "OIL knife"));
  assert.ok(!matchesStyleSearch(text.oil, "oil jellyfish"));
});

test("groups collapse, remember it, and open up while a search is active", async () => {
  const storage = memoryStorage();
  await withDialog(storage, async ({sections, byGroup, visibleCards, search, get}) => {
    assert.deepEqual(sections().map(section => section.dataset.group), ["Painting", "Craft & texture", "Strange"]);
    assert.equal(byGroup("Painting").querySelector(".style-group-count").textContent, "2");
    assert.equal(get("customStyleSection").hidden, true, "no custom styles, no custom group");

    byGroup("Painting").querySelector(".style-group-header").click();
    assert.equal(byGroup("Painting").querySelector(".style-grid").hidden, true);
    assert.equal(byGroup("Painting").querySelector(".style-group-header").getAttribute("aria-expanded"), "false");
    assert.deepEqual(JSON.parse(storage.getItem("realityRestyle.collapsedStyleGroups")), ["Painting"]);

    search("oil");
    assert.deepEqual(visibleCards(), ["Impasto oil"]);
    assert.equal(byGroup("Painting").querySelector(".style-grid").hidden, false, "search expands collapsed groups");
    assert.equal(byGroup("Strange").hidden, true);
    assert.equal(byGroup("Painting").querySelector(".style-group-count").textContent, "1");
    // Headers do not fold groups mid-search.
    byGroup("Painting").querySelector(".style-group-header").click();
    assert.deepEqual(JSON.parse(storage.getItem("realityRestyle.collapsedStyleGroups")), ["Painting"]);

    search("strange");
    assert.deepEqual(visibleCards(), ["Cat people", "Bioluminescent deep sea"]);

    search("zebra");
    assert.deepEqual(visibleCards(), []);
    assert.equal(get("styleSearchEmpty").hidden, false);
    assert.equal(get("styleSearchEmpty").textContent, "No styles match “zebra”");

    search("");
    assert.equal(get("styleSearchEmpty").hidden, true);
    assert.equal(byGroup("Painting").querySelector(".style-grid").hidden, true, "collapsed state returns");
    assert.equal(sections().every(section => !section.hidden), true);
  });
  // A later visit starts with the same groups folded.
  await withDialog(storage, async ({byGroup}) => {
    assert.equal(byGroup("Painting").querySelector(".style-grid").hidden, true);
    assert.equal(byGroup("Strange").querySelector(".style-grid").hidden, false);
  });
});

test("tapping a found style still applies it, and Enter puts the keyboard away", async () => {
  await withDialog(memoryStorage(), async ({byGroup, search, get, applied}) => {
    search("cat");
    const enter = {key: "Enter", preventDefault() { this.prevented = true; }};
    get("styleSearch").emit("keydown", enter);
    assert.equal(enter.prevented, true);
    assert.equal(get("styleSearch").blurred, true);
    byGroup("Strange").querySelector(".style-grid").children[0].click({});
    assert.deepEqual(applied, [catalog[3].prompt]);
    assert.equal(get("stylesDialog").open, false);
  });
});

test("storage that throws leaves every group open", async () => {
  const broken = {getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); }};
  await withDialog(broken, async ({byGroup}) => {
    assert.equal(byGroup("Painting").querySelector(".style-grid").hidden, false);
    byGroup("Painting").querySelector(".style-group-header").click();
    assert.equal(byGroup("Painting").querySelector(".style-grid").hidden, true);
  });
});

test("search sits above the list and lifts the dialog above the keyboard", () => {
  const html = readFileSync(new URL("../src/web/index.html", import.meta.url), "utf8");
  const css = readFileSync(new URL("../src/web/style.css", import.meta.url), "utf8");
  const app = readFileSync(new URL("../src/web/app.js", import.meta.url), "utf8");
  assert.match(html, /id="stylesDialog"[\s\S]*?id="styleSearch" type="search"[\s\S]*?id="styleList"/);
  assert.doesNotMatch(html, /addCustomSectionButton|Add Custom Section/);
  assert.match(html, /id="customStyleGroups"[\s\S]*?id="customStyleSection"[\s\S]*?id="presetStyles"/);
  assert.match(html, /<select id="styleSection"/);
  assert.match(html, /id="styleSearchEmpty"[^>]*role="status"/);
  // dialog.show() focuses the first focusable element; that must not be the search field, or every open
  // would raise the keyboard. Close keeps the focus it had before search existed.
  assert.match(html, /id="closeStylesButton"[^>]*autofocus/);
  assert.doesNotMatch(html.match(/<input id="styleSearch"[^>]*>/)[0], /autofocus/);
  // The search field joins the shared keyboard handling, which sets --keyboard-top and --keyboard-height.
  assert.match(app, /const textFields = "[^"]*input\[type='search'\]/);
  const lifted = css.match(/\.text-entry #stylesDialog\[open\][^{]*\{[^}]*\}/)?.[0] ?? "";
  assert.match(lifted, /top: calc\(var\(--keyboard-top, 0px\)/);
  assert.match(lifted, /height: calc\(var\(--keyboard-height, 100dvh\)/);
  assert.match(lifted, /bottom: auto/);
  assert.match(css, /\.text-entry #stylesDialog \.style-toolbar/);
  // Flat fill on the glass, no second glass layer for the field.
  const field = css.match(/\.style-search\s*\{[^}]*\}/)?.[0] ?? "";
  assert.match(field, /background: var\(--fill/);
  assert.doesNotMatch(field, /backdrop-filter/);
  assert.match(css, /\.style-card\[hidden\]/);
});
