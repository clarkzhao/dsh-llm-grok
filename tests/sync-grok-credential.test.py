#!/usr/bin/env python3
"""Unit tests for scripts/sync-grok-credential.py (no live DSH / grok files)."""

import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPT = os.path.join(ROOT, 'scripts', 'sync-grok-credential.py')


def run_sync(auth_path, cred_path):
    env = os.environ.copy()
    env['GROK_AUTH_JSON'] = auth_path
    env['DSH_CREDENTIALS'] = cred_path
    return subprocess.run(
        [sys.executable, SCRIPT],
        env=env,
        capture_output=True,
        text=True,
    )


def write(path, text):
    with open(path, 'w', encoding='utf-8') as f:
        f.write(text)


def read(path):
    with open(path, encoding='utf-8') as f:
        return f.read()


class SyncGrokCredentialTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.auth = os.path.join(self.tmp.name, 'auth.json')
        self.cred = os.path.join(self.tmp.name, '.credentials.yaml')

    def tearDown(self):
        self.tmp.cleanup()

    def write_auth(self, token):
        write(self.auth, json.dumps({
            'https://auth.x.ai::client': {'key': token, 'refresh_token': 'r'}
        }))

    def test_writes_versioned_refs(self):
        self.write_auth('tok-new')
        write(self.cred, 'version: 1\nrefs:\n  OTHER: keep-me\n')
        result = run_sync(self.auth, self.cred)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('synced GROK_SESSION_TOKEN', result.stdout)
        text = read(self.cred)
        self.assertIn('  GROK_SESSION_TOKEN: tok-new', text)
        self.assertIn('  OTHER: keep-me', text)
        self.assertTrue(text.startswith('version: 1'))
        self.assertEqual(stat.S_IMODE(os.stat(self.cred).st_mode), 0o600)

    def test_updates_existing_versioned_token(self):
        self.write_auth('tok-b')
        write(self.cred, 'version: 1\nrefs:\n  GROK_SESSION_TOKEN: tok-a\n')
        result = run_sync(self.auth, self.cred)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(read(self.cred), 'version: 1\nrefs:\n  GROK_SESSION_TOKEN: tok-b\n')

    def test_noop_when_already_in_sync(self):
        self.write_auth('same')
        write(self.cred, 'version: 1\nrefs:\n  GROK_SESSION_TOKEN: same\n')
        before = os.stat(self.cred)
        result = run_sync(self.auth, self.cred)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, '')
        after = os.stat(self.cred)
        self.assertEqual(before.st_mtime, after.st_mtime)

    def test_strips_stray_flat_key_from_versioned_doc(self):
        self.write_auth('tok-new')
        write(
            self.cred,
            'version: 1\nrefs:\n  GROK_SESSION_TOKEN: tok-old\nGROK_SESSION_TOKEN: stray\n',
        )
        result = run_sync(self.auth, self.cred)
        self.assertEqual(result.returncode, 0, result.stderr)
        text = read(self.cred)
        self.assertEqual(text, 'version: 1\nrefs:\n  GROK_SESSION_TOKEN: tok-new\n')
        self.assertNotIn('GROK_SESSION_TOKEN: stray', text)

    def test_flat_document_still_writes_top_level(self):
        self.write_auth('flat-tok')
        write(self.cred, 'OTHER: keep\n')
        result = run_sync(self.auth, self.cred)
        self.assertEqual(result.returncode, 0, result.stderr)
        text = read(self.cred)
        self.assertIn('GROK_SESSION_TOKEN: flat-tok', text)
        self.assertIn('OTHER: keep', text)
        self.assertNotIn('refs:', text)

    def test_missing_auth_does_not_touch_credentials(self):
        write(self.cred, 'version: 1\nrefs:\n  GROK_SESSION_TOKEN: keep\n')
        result = run_sync(self.auth, self.cred)
        self.assertEqual(result.returncode, 1)
        self.assertIn('cannot read', result.stderr)
        self.assertEqual(read(self.cred), 'version: 1\nrefs:\n  GROK_SESSION_TOKEN: keep\n')


if __name__ == '__main__':
    unittest.main()
