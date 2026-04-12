@echo off
REM claude-fixed.bat — Windows wrapper for Claude Code with cache-fix interceptor.
REM
REM Resolves the npm global root dynamically, constructs a file:/// URL for the
REM preload module (converting backslashes to forward slashes for Node.js), and
REM launches Claude Code with the interceptor active.
REM
REM Usage:
REM   claude-fixed [any claude args...]
REM
REM Prerequisites:
REM   npm install -g claude-code-cache-fix
REM   npm install -g @anthropic-ai/claude-code
REM
REM Save this file somewhere in your PATH (e.g. C:\Users\<you>\bin\claude-fixed.bat).
REM
REM Credit: @TomTheMenace (https://github.com/anthropics/claude-code/issues/38335)
REM Part of claude-code-cache-fix: https://github.com/cnighswonger/claude-code-cache-fix

for /f "delims=" %%G in ('npm root -g') do set "NPM_GLOBAL=%%G"
set NODE_OPTIONS=--import file:///%NPM_GLOBAL:\=/%/claude-code-cache-fix/preload.mjs
node "%NPM_GLOBAL%\@anthropic-ai\claude-code\cli.js" %*
