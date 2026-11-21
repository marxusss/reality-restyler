#!/usr/bin/env python3
"""Offline, syntax-aware code graph. No application source is sent to external services."""
from __future__ import annotations

import argparse
import ast
import collections
import json
import re
import subprocess
from pathlib import Path

from tree_sitter_language_pack import get_parser

LANGUAGES = {".py": "python", ".js": "javascript", ".mjs": "javascript",
             ".ps1": "powershell", ".cs": "csharp", ".iss": "inno"}
FUNCTION_TYPES = {
    "javascript": {"function_declaration", "function_expression", "generator_function_declaration",
                   "generator_function", "arrow_function", "method_definition"},
    "csharp": {"method_declaration", "constructor_declaration", "local_function_statement",
               "lambda_expression", "anonymous_method_expression", "operator_declaration"},
}
CALL_RE = re.compile(r"(?<![\w$])([A-Za-z_$][\w$]*)\s*\(")
PS_FUNCTION = re.compile(r"^\s*function\s+([\w-]+)", re.I | re.M)
INNO_FUNCTION = re.compile(r"^\s*(function|procedure|constructor|destructor)\s+([\w]+)", re.I | re.M)


def source_text(raw, start, end):
    return raw[start:end].decode("utf-8", errors="replace")


def describe_arrow(node, raw):
    parent = node.parent
    while parent and parent.type in {"parenthesized_expression", "assignment_expression"}:
        parent = parent.parent
    if parent and parent.type in {"variable_declarator", "pair", "public_field_definition"}:
        name = parent.child_by_field_name("name") or parent.child_by_field_name("key")
        if name:
            return source_text(raw, name.start_byte, name.end_byte)
    if parent and parent.type == "call_expression":
        head = source_text(raw, parent.start_byte, min(parent.end_byte, node.start_byte))
        event = re.search(r"(?:addEventListener|\.on|\.addEventListener)\s*\(\s*['\"]([\w-]+)", head)
        if event:
            return "on:" + event.group(1)
        callee = re.search(r"([A-Za-z_$][\w$]*)\s*\(", head)
        if callee:
            return "callback:" + callee.group(1)
    return "callback"


def git_files(root):
    paths = subprocess.check_output(["git", "-C", str(root), "ls-files", "-z"]).decode().split("\0")
    return [p for p in paths if p and (root / p).is_file()]


def build(root: Path, sha: str, repository: str):
    paths = git_files(root)
    nodes, edges, findings = [], [], []
    functions = []
    file_ids = {}
    bodies = {}
    texts = {}
    language_files = collections.Counter()
    for path in paths:
        suffix = Path(path).suffix.lower()
        language = LANGUAGES.get(suffix, "asset" if suffix in {".webp", ".png", ".gif", ".mp4", ".svg", ".ico"} else "document")
        ident = len(nodes)
        file_ids[path] = ident
        nodes.append({"id": ident, "name": path, "path": path, "line": 1,
                      "end": 1, "lang": language, "kind": "file", "folder": path.split("/")[0] if "/" in path else "root"})
        if suffix in LANGUAGES or suffix in {".yml", ".yaml", ".html"}:
            texts[path] = (root / path).read_text(encoding="utf-8-sig")
            if suffix in LANGUAGES:
                language_files[language] += 1

    def add(path, name, line, end, kind, lang, body, column=0):
        ident = len(nodes)
        label = str(name).strip() or "anonymous"
        nodes.append({"id": ident, "name": label, "path": path, "line": line, "end": end,
                      "column": column, "lang": lang, "kind": kind, "folder": path.split("/")[0] if "/" in path else "root"})
        edges.append([file_ids[path], ident, "contains"])
        functions.append(ident)
        bodies[ident] = body
        return ident

    for path, source in texts.items():
        lang = LANGUAGES.get(Path(path).suffix.lower())
        if not lang:
            continue
        if lang == "python":
            try:
                tree = ast.parse(source, filename=path)
            except SyntaxError as exc:
                raise SystemExit(f"Cannot enumerate all Python functions in {path}: {exc}")
            lines = source.splitlines(keepends=True)

            def visit(obj, owner=""):
                if isinstance(obj, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    name = owner + obj.name
                    add(path, name, obj.lineno, obj.end_lineno or obj.lineno,
                        "method" if owner else "function", lang,
                        "".join(lines[obj.lineno-1:(obj.end_lineno or obj.lineno)]), obj.col_offset)
                    owner = name + "."
                elif isinstance(obj, ast.ClassDef):
                    name = owner + obj.name
                    add(path, name, obj.lineno, obj.end_lineno or obj.lineno,
                        "class", lang, "", obj.col_offset)
                    owner = name + "."
                elif isinstance(obj, ast.Lambda):
                    add(path, owner + "<lambda>", obj.lineno, obj.end_lineno or obj.lineno,
                        "lambda", lang, "".join(lines[obj.lineno-1:(obj.end_lineno or obj.lineno)]), obj.col_offset)
                for child in ast.iter_child_nodes(obj):
                    visit(child, owner)
            visit(tree)
            expected = len(re.findall(r"^\s*(?:async\s+)?def\s+", source, re.M))
            actual = sum(1 for n in nodes if n["path"] == path and n["lang"] == "python" and n["kind"] in ("function", "method"))
            if actual != expected:
                raise SystemExit(f"Incomplete Python inventory: {path} ({actual}/{expected})")
        elif lang == "inno":
            code_at = source.lower().find("[code]")
            code = source[code_at:] if code_at >= 0 else source
            offset = source[:code_at].count("\n") if code_at >= 0 else 0
            declarations = list(INNO_FUNCTION.finditer(code))
            for i, match in enumerate(declarations):
                lineno = offset + code[:match.start()].count("\n") + 1
                end = offset + (code[:declarations[i+1].start()].count("\n") if i+1 < len(declarations) else code.count("\n")) + 1
                snippet = code[match.start():(declarations[i+1].start() if i+1 < len(declarations) else len(code))]
                add(path, match.group(2), lineno, end, "function", lang, snippet)
        else:
            raw = source.encode("utf-8")
            try:
                parser = get_parser(lang)
                tree = parser.parse(raw)
            except Exception as exc:
                findings.append(f"{path}: parser unavailable, using fallback ({exc})")
                tree = None

            found = set()
            if tree is not None:
                stack = [tree.root_node]
                while stack:
                    node = stack.pop()
                    stack.extend(reversed(node.named_children))
                    kind = node.type
                    accepted = kind in FUNCTION_TYPES.get(lang, set())
                    if lang == "powershell" and "function" in kind:
                        accepted = True
                    if lang == "powershell" and kind in {"script_block_expression", "scriptblock_expression"}:
                        accepted = True
                    if not accepted:
                        continue
                    snippet = source_text(raw, node.start_byte, node.end_byte)
                    name_node = node.child_by_field_name("name")
                    name = source_text(raw, name_node.start_byte, name_node.end_byte) if name_node else ""
                    if lang == "powershell":
                        declaration = PS_FUNCTION.search(snippet[:160])
                        if declaration:
                            name = declaration.group(1)
                        elif not name:
                            name = "scriptblock"
                    if kind in {"arrow_function", "lambda_expression", "anonymous_method_expression"} and not name:
                        name = describe_arrow(node, raw)
                    if not name:
                        name = "anonymous"
                    key = (node.start_point.row + 1, node.start_point.column, kind)
                    if key in found:
                        continue
                    found.add(key)
                    label = name if name != "anonymous" else f"anonymous@{node.start_point.row+1}:{node.start_point.column+1}"
                    add(path, label, node.start_point.row + 1, node.end_point.row + 1,
                        "callback" if kind in {"arrow_function", "lambda_expression", "anonymous_method_expression", "script_block_expression", "scriptblock_expression"} else "method" if kind in {"method_definition","method_declaration","constructor_declaration","local_function_statement"} else "function",
                        lang, snippet, node.start_point.column)
                if tree.root_node.has_error:
                    findings.append(path + ": parser reported syntax errors; checked declared functions with fallback")

            if lang == "powershell":
                for match in PS_FUNCTION.finditer(source):
                    line = source[:match.start()].count("\n") + 1
                    if not any(n["path"] == path and n["line"] == line and n["name"] == match.group(1) for n in nodes):
                        add(path, match.group(1), line, line, "function", lang, source[match.start():match.start()+200])
                for match in re.finditer(r"\bAdd_(\w+)\s*\(\s*\{|\b(?:ForEach-Object|Where-Object|Register-ObjectEvent)\s*\{", source, re.I):
                    line = source[:match.start()].count("\n") + 1
                    if not any(n["path"] == path and n["line"] == line and n["kind"] == "callback" for n in nodes):
                        add(path, "event:" + (match.group(1) or "scriptblock"), line, line, "callback", lang, source[match.start():match.start()+250])
            if lang == "javascript":
                # Audit arrow tokens; if the parser missed one, keep a visible inventory entry.
                line_arrows = collections.Counter()
                for match in re.finditer(r"=>", source):
                    line_arrows[source[:match.start()].count("\n")+1] += 1
                parsed = collections.Counter(n["line"] for n in nodes if n["path"] == path and n["kind"] == "callback")
                for line, total in line_arrows.items():
                    for index in range(max(0, total - parsed[line])):
                        add(path, f"arrow@{line}:{index+1}", line, line, "callback", lang, source.splitlines()[line-1])
                        findings.append(f"{path}:{line}: arrow recovered by lexical audit")
            if lang == "csharp":
                for match in re.finditer(r"^\s*(?:public|private|internal|protected|static)\s+(?:static\s+)?[\w<>,?\[\]\s]+\s+(\w+)\s*\(", source, re.M):
                    line = source[:match.start()].count("\n") + 1
                    if not any(n["path"] == path and n["line"] == line for n in nodes):
                        add(path, match.group(1), line, line, "method", lang, source[match.start():match.start()+200])

    # File-to-file imports: only local repository targets are included.
    for path, source in texts.items():
        targets = set()
        if path.endswith(".py"):
            for match in re.finditer(r"^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))", source, re.M):
                mod = (match.group(1) or match.group(2)).lstrip(".").replace(".", "/")
                for target in (mod + ".py", mod + "/__init__.py"):
                    if target in file_ids:
                        targets.add(target)
        elif path.endswith((".js", ".mjs")):
            for match in re.finditer(r"(?:from\s*|import\s*)['\"](\.[^'\"]+)['\"]", source):
                target = (Path(path).parent / match.group(1)).as_posix()
                if target in file_ids:
                    targets.add(target)
        for target in targets:
            edges.append([file_ids[path], file_ids[target], "imports"])

    names = collections.defaultdict(list)
    for ident in functions:
        node = nodes[ident]
        if node["kind"] == "class":
            continue
        plain = node["name"].split(".")[-1]
        if re.fullmatch(r"[\w$-]+", plain):
            names[plain.lower()].append(ident)

    # Conservative lexical calls; ambiguous cross-file calls intentionally omitted.
    seen = set(tuple(x) for x in edges)
    for ident in functions:
        n = nodes[ident]
        body = bodies.get(ident, "")
        found_names = set(CALL_RE.findall(body))
        if n["lang"] == "powershell":
            for name in names:
                if "-" in name and re.search(r"(?<![\w-])" + re.escape(name) + r"(?![\w-])", body, re.I):
                    found_names.add(name)
        for name in found_names:
            options = names.get(name.lower(), [])
            local = [other for other in options if nodes[other]["path"] == n["path"]]
            targets = local if len(local) == 1 else options if len(options) == 1 else []
            for target in targets:
                edge = (ident, target, "calls")
                if edge not in seen:
                    seen.add(edge)
                    edges.append(list(edge))

    # Workflows are mapped as executable entrypoints, not falsely labeled as source functions.
    for path, source in texts.items():
        if not path.endswith((".yml", ".yaml")):
            continue
        for match in re.finditer(r"^\s{6}-\s+name:\s*(.*)$", source, re.M):
            line = source[:match.start()].count("\n") + 1
            add(path, match.group(1).strip(), line, line, "workflow_step", "yaml", "")

    count = collections.Counter(n["kind"] for n in nodes)
    graph = {
        "sha": sha, "repository": repository, "nodes": nodes, "edges": edges,
        "stats": {"files": len(paths), "routines": sum(count[k] for k in ("function","method","lambda","callback")),
                  "classes": count["class"], "workflow_steps": count["workflow_step"],
                  "call_edges": sum(e[2] == "calls" for e in edges),
                  "file_import_edges": sum(e[2] == "imports" for e in edges),
                  "language_files": dict(language_files)},
        "findings": findings,
    }
    return graph


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path("."))
    parser.add_argument("--out", type=Path, default=Path("dist/reality-restyler-codegraph.html"))
    parser.add_argument("--sha", default="")
    parser.add_argument("--repository", default="marxusss/reality-restyler")
    args = parser.parse_args()
    root = args.root.resolve()
    sha = args.sha or subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], text=True).strip()
    graph = build(root, sha, args.repository)
    template = Path(__file__).with_name("codegraph_template.html").read_text(encoding="utf-8")
    data = json.dumps(graph, ensure_ascii=False, separators=(",", ":")).replace("<", "\\u003c")
    if "__GRAPH_DATA__" not in template:
        raise SystemExit("Graph template is missing the data placeholder")
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(template.replace("__GRAPH_DATA__", data), encoding="utf-8")
    args.out.with_suffix(".json").write_text(json.dumps(graph, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(graph["stats"], indent=2))
    if graph["findings"]:
        print("Extraction diagnostics:\n" + "\n".join(graph["findings"]))
    print("Standalone graph:", args.out)


if __name__ == "__main__":
    main()
