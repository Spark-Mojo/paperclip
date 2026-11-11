#!/usr/bin/env python3
"""SPA-17842 — prepared (NOT applied) edit: remove ONE antigravity member from OmniRoute combo `cheap`.

Modes
  --check            READ-ONLY. Opens storage.sqlite with file:...?mode=ro. No credential, no network, no write.
                     Runs: row dump, drift guard vs cheap-before.json, target-found-exactly-once, candidatePool check.
  --apply            WRITES via PATCH /api/combos/<id> (the gateway's own route; busts its combo cache).
                     Needs OMNIROUTE_MGMT_TOKEN in env (Rev's credential) and --backup-dir. Refuses without
                     --i-have-approval <DR-id>/<Ty-signoff-ref>. THIS LEAF NEVER RUNS --apply.
  --rollback FILE    WRITES via PATCH: restores the `models` array from a backup file written by --apply.

Exit codes: 0 ok / idempotent no-op, 2 usage/config, 3 transport, 4 auth, 5 drift (zero writes), 6 write rejected/verify failed.
"""
import argparse, hashlib, json, os, sqlite3, sys, urllib.request, urllib.error, datetime, pathlib

HERE = pathlib.Path(__file__).resolve().parent
COMBO_ID = "7b7295a0-7880-41ad-8cec-953bbed211ac"
COMBO_NAME = "cheap"
TARGET = "cheap-model-1-antigravity-gpt-oss-120b-medium-1094d5f9-bca7-4030-8a9f-d6ad89f1458f"
DB = "/home/jamesilsley/.machine-omniroute/data/storage.sqlite"
URL = os.environ.get("OMNIROUTE_MGMT_URL", "http://127.0.0.1:20128").rstrip("/")


def canon(d):
    return hashlib.sha256(json.dumps(d, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def load_before():
    return json.load(open(HERE / "cheap-before.json"))


def read_sqlite():
    c = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    r = c.execute("select id,name,data from combos where id=?", (COMBO_ID,)).fetchone()
    if not r:
        return None
    return json.loads(r[2])


def http(method, path, body=None):
    tok = os.environ.get("OMNIROUTE_MGMT_TOKEN")
    if not tok or "\n" in tok or "\r" in tok:
        print("FAIL(config): OMNIROUTE_MGMT_TOKEN missing/invalid", file=sys.stderr); sys.exit(2)
    req = urllib.request.Request(URL + path, method=method,
                                 data=None if body is None else json.dumps(body).encode(),
                                 headers={"Authorization": "Bearer " + tok, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            print(f"FAIL(auth): HTTP {e.code}", file=sys.stderr); sys.exit(4)
        return e.code, {"error": e.read().decode(errors="replace")[:500]}
    except Exception as e:
        print(f"FAIL(transport): {e}", file=sys.stderr); sys.exit(3)


def guard(live, before):
    """Return list of drift reasons (empty = guard passes). Compares to the frozen cheap-before.json."""
    b = before["data"]
    why = []
    if live.get("id") != COMBO_ID: why.append("id differs")
    if live.get("version") != b.get("version"): why.append(f"version {live.get('version')} != {b.get('version')}")
    if live.get("updatedAt") != b.get("updatedAt"): why.append(f"updatedAt {live.get('updatedAt')} != {b.get('updatedAt')}")
    lm = [m.get("id") for m in live.get("models", [])]
    bm = [m.get("id") for m in b.get("models", [])]
    if lm != bm: why.append(f"member id list differs: {lm} != {bm}")
    if live.get("config", {}).get("candidatePool") != b["config"].get("candidatePool"): why.append("candidatePool differs")
    if canon(live) != before["data_canonical_sha256"]: why.append("canonical sha256 of row data differs")
    return why


def plan(live):
    ids = [m.get("id") for m in live["models"]]
    n = ids.count(TARGET)
    new_models = [m for m in live["models"] if m.get("id") != TARGET]
    pool = live.get("config", {}).get("candidatePool", [])
    return n, new_models, pool


def cmd_check():
    before = load_before()
    live = read_sqlite()
    if live is None:
        print("FAIL: combo row not found"); return 5
    why = guard(live, before)
    n, new_models, pool = plan(live)
    print(f"row id={live['id']} name={live['name']} version={live['version']} updatedAt={live['updatedAt']} strategy={live['strategy']}")
    print(f"canonical sha256(row data) live={canon(live)} frozen={before['data_canonical_sha256']}")
    print(f"drift guard: {'PASS (no drift)' if not why else 'FAIL ' + '; '.join(why)}")
    print(f"target member id occurrences: {n} (need exactly 1)")
    print(f"members now={len(live['models'])} after removal={len(new_models)}")
    print(f"candidatePool={pool}; contains antigravity: {'antigravity' in pool} -> candidatePool needs no change: {'antigravity' not in pool}")
    print("remaining member ids after removal:")
    for m in new_models: print("  ", m["id"])
    print("antigravity members remaining after removal:", [m["id"] for m in new_models if "antigravity" in json.dumps(m)])
    print("WRITES PERFORMED: 0 (sqlite opened mode=ro)")
    if why: return 5
    return 0 if n == 1 else 5


def cmd_apply(a):
    if not a.i_have_approval or not a.backup_dir:
        print("FAIL(usage): --apply needs --i-have-approval <DR/sign-off refs> and --backup-dir", file=sys.stderr); return 2
    before = load_before()
    st, live = http("GET", f"/api/combos/{COMBO_ID}")
    if st != 200: print(f"FAIL(transport): GET -> {st} {live}", file=sys.stderr); return 3
    n, new_models, pool = plan(live)
    if n == 0:
        # idempotent re-run: only a no-op if the remainder equals the expected post-state exactly
        exp = [m["id"] for m in before["data"]["models"] if m["id"] != TARGET]
        if [m["id"] for m in live["models"]] == exp:
            print("NO-OP: target already absent and remaining members match expected post-state; 0 writes"); return 0
        print("DRIFT: target absent but member list is not the expected post-state; 0 writes"); return 5
    why = guard(live, before)
    if why or n != 1:
        print("DRIFT (0 writes): " + "; ".join(why) + f"; target occurrences={n}"); return 5
    if "antigravity" in pool:
        print("DRIFT (0 writes): candidatePool contains antigravity; procedure assumes it does not"); return 5
    ts = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    pathlib.Path(a.backup_dir).mkdir(parents=True, exist_ok=True)
    bp = pathlib.Path(a.backup_dir) / f"cheap-row-backup-{ts}.json"
    raw = json.dumps(live, indent=2, sort_keys=True)
    bp.write_text(raw)
    print(f"BACKUP {bp} sha256={hashlib.sha256(raw.encode()).hexdigest()}")
    st, res = http("PATCH", f"/api/combos/{COMBO_ID}", {"models": new_models})
    if st != 200: print(f"FAIL(write rejected): PATCH -> {st} {res}", file=sys.stderr); return 6
    st, after = http("GET", f"/api/combos/{COMBO_ID}")
    ids = [m["id"] for m in after.get("models", [])]
    ok = st == 200 and TARGET not in ids and ids == [m["id"] for m in new_models] and after.get("config", {}).get("candidatePool") == pool
    print(f"VERIFY after-ids={ids} candidatePool={after.get('config',{}).get('candidatePool')} -> {'OK' if ok else 'MISMATCH (run --rollback now)'}")
    return 0 if ok else 6


def cmd_rollback(a):
    if not a.i_have_approval: print("FAIL(usage): --rollback needs --i-have-approval", file=sys.stderr); return 2
    bk = json.load(open(a.rollback))
    st, res = http("PATCH", f"/api/combos/{COMBO_ID}", {"models": bk["models"]})
    if st != 200: print(f"FAIL: PATCH -> {st} {res}", file=sys.stderr); return 6
    st, after = http("GET", f"/api/combos/{COMBO_ID}")
    ok = [m["id"] for m in after["models"]] == [m["id"] for m in bk["models"]]
    print("ROLLBACK", "OK (members restored; updatedAt is NOT restorable via the API)" if ok else "MISMATCH")
    return 0 if ok else 6


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--check", action="store_true"); g.add_argument("--apply", action="store_true"); g.add_argument("--rollback")
    p.add_argument("--i-have-approval"); p.add_argument("--backup-dir")
    a = p.parse_args()
    sys.exit(cmd_check() if a.check else cmd_apply(a) if a.apply else cmd_rollback(a))
