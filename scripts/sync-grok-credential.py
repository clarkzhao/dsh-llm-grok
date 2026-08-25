#!/usr/bin/env python3
"""Sync the current Grok CLI credential (~/.grok/auth.json) into DSH's
credentials file (~/.dsh/.credentials.yaml) whenever they differ.

DSH's credentials provider watches the file (chokidar) and hot-publishes
external edits, so no DSH restart is needed after this script runs.

Designed to run on a schedule (launchd StartInterval / cron). Failures are
logged to stderr and never touch the existing DSH credential.

Paths can be overridden for tests:

  GROK_AUTH_JSON   default ~/.grok/auth.json
  DSH_CREDENTIALS  default ~/.dsh/.credentials.yaml
"""

import json
import os
import re
import sys
import tempfile

GROK_AUTH = os.path.expanduser(os.environ.get('GROK_AUTH_JSON', '~/.grok/auth.json'))
DSH_CRED = os.path.expanduser(os.environ.get('DSH_CREDENTIALS', '~/.dsh/.credentials.yaml'))
KEY = 'GROK_SESSION_TOKEN'


def read_grok_token():
    # No PEP 604 union annotations: macOS system python3 is 3.9.
    """Read the current access token from grok's auth.json. None on failure."""
    try:
        with open(GROK_AUTH, encoding='utf-8') as f:
            data = json.load(f)
    except Exception as e:
        print('sync-grok-credential: cannot read %s: %s' % (GROK_AUTH, e), file=sys.stderr)
        return None
    for value in data.values():
        if isinstance(value, dict) and isinstance(value.get('key'), str) and value['key']:
            return value['key']
    print('sync-grok-credential: no usable token in %s' % GROK_AUTH, file=sys.stderr)
    return None


def main():
    token = read_grok_token()
    if token is None:
        return 1

    try:
        with open(DSH_CRED, encoding='utf-8') as f:
            content = f.read()
    except FileNotFoundError:
        content = ''
    except Exception as e:
        print('sync-grok-credential: cannot read %s: %s' % (DSH_CRED, e), file=sys.stderr)
        return 1

    versioned = bool(
        re.search(r'^version:\s*1\s*$', content, re.M)
        and re.search(r'^refs:\s*$', content, re.M)
    )
    if versioned:
        # Drop a stray unindented copy a previous flat write may have appended.
        stripped = re.sub(r'^%s:[ \t]*.*\n?' % KEY, '', content, flags=re.M)
        indented = re.compile(r'^  %s:[ \t]*.*$' % KEY, re.M)
        replacement = '  %s: %s' % (KEY, token)
        if indented.search(stripped):
            if re.search(r'^  %s:[ \t]*%s$' % (KEY, re.escape(token)), stripped, re.M):
                if stripped == content:
                    return 0  # already in sync under refs, no stray copy
                new_content = stripped
            else:
                new_content = indented.sub(replacement, stripped, count=1)
        else:
            new_content = re.sub(
                r'^refs:\s*$',
                'refs:\n%s' % replacement,
                stripped,
                count=1,
                flags=re.M,
            )
    else:
        line_pattern = re.compile(r'^%s:\s*\S+' % KEY, re.M)
        if line_pattern.search(content):
            if re.search(r'^%s:\s*%s$' % (KEY, re.escape(token)), content, re.M):
                return 0  # already in sync
            new_content = line_pattern.sub('%s: %s' % (KEY, token), content)
        else:
            new_content = (content.rstrip() + '\n' if content else '') + '%s: %s\n' % (KEY, token)

    # Atomic replace in the same directory (same filesystem) with
    # owner-only permissions, matching the credentials provider's policy.
    directory = os.path.dirname(DSH_CRED) or '.'
    fd, tmp = tempfile.mkstemp(dir=directory, prefix='.credentials.yaml.tmp')
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            f.write(new_content)
        os.chmod(tmp, 0o600)
        os.replace(tmp, DSH_CRED)
        print('sync-grok-credential: synced %s (%s chars)' % (KEY, len(token)))
    except Exception as e:
        print('sync-grok-credential: write failed: %s' % e, file=sys.stderr)
        return 1
    finally:
        if os.path.exists(tmp):
            try:
                os.unlink(tmp)
            except OSError:
                pass
    return 0


if __name__ == '__main__':
    sys.exit(main())
