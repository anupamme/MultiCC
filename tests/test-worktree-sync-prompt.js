'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHostPrompts } = require('../src/chat/host-prompts');
const prompt = createHostPrompts({ PORT: '3000' }).multiccImgHint;

test('worktree prompt distinguishes same-session busy from real sync conflicts', () => {
  assert.match(prompt, /not the required path for an agent to sync itself \(a running session gets 409 busy by design\)/);
  assert.match(prompt, /Self-sync: align with the local base branch directly with Git/);
  assert.match(prompt, /git status --short/);
  assert.match(prompt, /git rev-list --left-right --count HEAD\.\.\.main/);
  assert.match(prompt, /only `0 0` means fully aligned/);
  assert.match(prompt, /stop and report when dirty, conflicted or of unclear ownership/);
  assert.match(prompt, /do not mistake the endpoint's `unmerged` wording for a Git index conflict/);
});

test('English publication language does not change the requested conversation language', () => {
  assert.match(prompt, /All new Git commit messages \(subject and body/);
  assert.match(prompt, /release notes \(title, headings and body\) must be written in English/);
  assert.match(prompt, /Keep user-facing conversation, progress and delivery reports in the language requested by the user/);
  assert.match(prompt, /use its name and email for both Git Author and Committer on every new commit/);
});
