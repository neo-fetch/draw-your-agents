#!/usr/bin/env python3
"""Dependency-free conformance smoke test for Graph IR fixtures.

Phase-0 stand-in for the authoritative TypeScript validator in packages/ir
(which needs Node, not yet installed). It checks the invariants documented in
docs/IR-SCHEMA.md so a fixture can be proven well-formed today, using only the
Python standard library.

Usage:
    python3 scripts/check_ir.py <fixture.ir.json> [more.ir.json ...]

Exits 0 if every fixture passes, 1 if any fails.
"""

import glob
import json
import keyword
import sys
from pathlib import Path

SCALARS = {"str", "int", "float", "bool", "date", "datetime"}
NODE_TYPES = {"agent", "function", "router", "tool", "join", "humanInput", "workflow"}


def is_ident(s) -> bool:
    return isinstance(s, str) and s.isidentifier() and not keyword.iskeyword(s)


class Checker:
    def __init__(self, ir):
        self.ir = ir
        self.errors = []
        self.nodes = {}        # id -> node
        self.names = {}        # name -> id
        self.schemas = {}      # schema name -> {field name -> field}

    def err(self, msg):
        self.errors.append(msg)

    # -- entry point --
    def run(self):
        for key in ("irVersion", "name", "nodes", "edges", "schemas"):
            if key not in self.ir:
                self.err(f"missing top-level key '{key}'")
        if self.errors:
            return self.errors
        if not is_ident(self.ir["name"]):
            self.err(f"workflow name is not a valid python identifier: {self.ir['name']!r}")

        self._index_schemas()
        self._index_nodes()
        for n in self.nodes.values():
            getattr(self, f"check_{n['type']}", self._noop)(n)
        self.check_edges()
        self.check_reachability_and_cycles()
        return self.errors

    def _noop(self, _n):
        pass

    # -- indexing --
    def _index_schemas(self):
        for s in self.ir["schemas"]:
            name = s.get("name")
            if not is_ident(name):
                self.err(f"schema name is not a valid identifier: {name!r}")
            self.schemas[name] = {f.get("name"): f for f in s.get("fields", [])}
            for f in s.get("fields", []):
                if not is_ident(f.get("name")):
                    self.err(f"schema {name}: bad field name {f.get('name')!r}")
                if f.get("type") not in SCALARS:
                    self.err(f"schema {name}.{f.get('name')}: bad type {f.get('type')!r}")

    def _index_nodes(self):
        for n in self.ir["nodes"]:
            nid, nm, t = n.get("id"), n.get("name"), n.get("type")
            if not nid:
                self.err("a node is missing 'id'")
                continue
            if nid in self.nodes:
                self.err(f"duplicate node id {nid!r}")
            self.nodes[nid] = n
            if t not in NODE_TYPES:
                self.err(f"node {nid}: unknown type {t!r}")
            if not is_ident(nm):
                self.err(f"node {nid}: name is not a valid python identifier: {nm!r}")
            elif nm in self.names:
                self.err(f"duplicate node name {nm!r} (used as the codegen symbol)")
            else:
                self.names[nm] = nid
        if "START" in self.names:
            self.err("'START' is reserved and cannot be a node name")

    # -- type ref helper --
    def ref_ok(self, ref, allow_none=False) -> bool:
        if ref is None:
            return allow_none
        if ref == "str":
            return True
        return ref in self.schemas

    def producer_output(self, node):
        cfg = node["config"]
        return cfg.get("outputType", cfg.get("outputSchemaRef"))

    # -- per-type checks --
    def check_agent(self, n):
        c = n["config"]
        ctx = f"agent {n['name']}"
        if not c.get("model"):
            self.err(f"{ctx}: missing model")
        if not self.ref_ok(c.get("outputSchemaRef")):
            self.err(f"{ctx}: unknown outputSchemaRef {c.get('outputSchemaRef')!r}")
        if not self.ref_ok(c.get("inputSchemaRef"), allow_none=True):
            self.err(f"{ctx}: unknown inputSchemaRef {c.get('inputSchemaRef')!r}")
        for seg in c.get("instruction", {}).get("segments", []):
            if seg.get("type") == "var":
                self.check_var_segment(ctx, c, seg)

    def check_var_segment(self, ctx, agent_cfg, seg):
        sch, fld, src = seg.get("schema"), seg.get("field"), seg.get("source")
        if src not in self.names:
            self.err(f"{ctx}: prompt variable source {src!r} is not a node")
        else:
            out = self.producer_output(self.nodes[self.names[src]])
            if out == "str" or out is None:
                self.err(
                    f"{ctx}: variable <{sch}.{fld} from {src}> requires {src} to output a "
                    f"structured schema, but it outputs {out!r}"
                )
            elif out != sch:
                self.err(
                    f"{ctx}: variable schema {sch!r} does not match {src} output schema {out!r}"
                )
        if sch not in self.schemas:
            self.err(f"{ctx}: unknown schema {sch!r}")
        elif fld not in self.schemas[sch]:
            self.err(f"{ctx}: schema {sch} has no field {fld!r}")
        if agent_cfg.get("inputSchemaRef") != sch:
            self.err(
                f"{ctx}: uses a variable from schema {sch} but inputSchemaRef is "
                f"{agent_cfg.get('inputSchemaRef')!r}"
            )

    def check_function(self, n):
        c = n["config"]
        ctx = f"function {n['name']}"
        if not self.ref_ok(c.get("inputType")):
            self.err(f"{ctx}: unknown inputType {c.get('inputType')!r}")
        if not self.ref_ok(c.get("outputType")):
            self.err(f"{ctx}: unknown outputType {c.get('outputType')!r}")

    def check_router(self, n):
        if not (n["config"].get("routes") or []):
            self.err(f"router {n['name']}: must declare at least one route")

    def check_humanInput(self, n):
        if not n["config"].get("message"):
            self.err(f"humanInput {n['name']}: missing message")

    # -- edges --
    def check_edges(self):
        for e in self.ir["edges"]:
            frm, to = e.get("from"), e.get("to")
            if frm != "START" and frm not in self.nodes:
                self.err(f"edge from unknown node {frm!r}")
            if to == "START":
                self.err("an edge points TO 'START', which is not allowed")
            elif to not in self.nodes:
                self.err(f"edge to unknown node {to!r}")
        if not any(e.get("from") == "START" for e in self.ir["edges"]):
            self.err("graph has no START edge")

        # router branch consistency
        for nid, n in self.nodes.items():
            if n["type"] != "router":
                continue
            declared = set(n["config"].get("routes", []))
            labels = {e.get("route") for e in self.ir["edges"] if e.get("from") == nid}
            if None in labels:
                self.err(f"router {n['name']}: has an outgoing edge without a route label")
                labels.discard(None)
            if declared - labels:
                self.err(f"router {n['name']}: routes with no target edge: {sorted(declared - labels)}")
            if labels - declared:
                self.err(f"router {n['name']}: edge routes not declared: {sorted(labels - declared)}")

        # non-router edges must not carry route labels
        for e in self.ir["edges"]:
            frm = e.get("from")
            is_router = frm != "START" and self.nodes.get(frm, {}).get("type") == "router"
            if e.get("route") and not is_router:
                self.err(f"edge {frm}->{e.get('to')} has a route label but {frm} is not a router")

    # -- graph shape --
    def check_reachability_and_cycles(self):
        adj = {}
        for e in self.ir["edges"]:
            adj.setdefault(e["from"], []).append(e["to"])

        # reachability from START
        seen, stack = set(), list(adj.get("START", []))
        while stack:
            x = stack.pop()
            if x in seen:
                continue
            seen.add(x)
            stack.extend(adj.get(x, []))
        for nid, n in self.nodes.items():
            if nid not in seen:
                self.err(f"node {n['name']} ({nid}) is unreachable from START")

        # cycle detection (DAG required in v1)
        WHITE, GREY, BLACK = 0, 1, 2
        color = {nid: WHITE for nid in self.nodes}

        def dfs(u):
            color[u] = GREY
            for v in adj.get(u, []):
                if v not in color:  # skips "START" and dangling targets
                    continue
                if color[v] == GREY:
                    self.err(f"cycle detected through node {self.nodes[v]['name']}")
                elif color[v] == WHITE:
                    dfs(v)
            color[u] = BLACK

        for nid in self.nodes:
            if color[nid] == WHITE:
                dfs(nid)


def main(argv):
    paths = []
    for a in argv[1:]:
        paths.extend(sorted(glob.glob(a)) or [a])
    if not paths:
        print("usage: check_ir.py <fixture.ir.json> ...")
        return 2

    ok = True
    for p in paths:
        try:
            ir = json.loads(Path(p).read_text())
        except Exception as ex:
            print(f"FAIL {p}: cannot parse JSON: {ex}")
            ok = False
            continue
        errors = Checker(ir).run()
        if errors:
            ok = False
            print(f"FAIL {p}  ({len(errors)} error(s)):")
            for e in errors:
                print(f"  - {e}")
        else:
            print(
                f"PASS {p}  "
                f"({len(ir.get('nodes', []))} nodes, "
                f"{len(ir.get('edges', []))} edges, "
                f"{len(ir.get('schemas', []))} schemas)"
            )
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
