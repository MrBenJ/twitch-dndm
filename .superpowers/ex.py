#!/usr/bin/env python3
"""ex.py PLAN TASK PATH [PATH...] : write each PATH from the code block labelled `PATH`: inside ### Task TASK."""
import re, sys, os
plan, task, paths = sys.argv[1], sys.argv[2], sys.argv[3:]
text = open(f"docs/superpowers/plans/{plan}").read()
m = re.search(rf"^### Task {task}:.*?(?=^### Task \d+:|^## Plan . self-review|\Z)", text, re.S | re.M)
sec = m.group(0)
for path in paths:
    pat = re.compile(r"`" + re.escape(path) + r"`[^\n]*:\n```[a-z]*\n(.*?)^```", re.S | re.M)
    found = pat.findall(sec)
    if not found:
        print(f"NOT FOUND: {path}"); continue
    body = found[-1] if len(found) > 1 and '--last' in os.environ.get('EXMODE','') else found[0]
    os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
    open(path, 'w').write(body)
    print(f"wrote {path} ({body.count(chr(10))} lines){' [multiple blocks: used first]' if len(found)>1 else ''}")
