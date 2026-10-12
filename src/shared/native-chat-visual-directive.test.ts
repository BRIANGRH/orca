import { describe, expect, it } from 'vitest'
import {
  NATIVE_CHAT_VISUAL_DIRECTIVE_MAX_LINE_LENGTH,
  NATIVE_CHAT_VISUAL_PATH_MAX_LENGTH,
  NATIVE_CHAT_VISUAL_TITLE_MAX_LENGTH,
  isNativeChatVisualPath,
  isPendingNativeChatVisualDirectiveTail,
  parseNativeChatVisualDirectiveLine,
  withoutNativeChatVisualDirectiveLines,
  withoutPendingNativeChatVisualDirectiveTail
} from './native-chat-visual-directive'

describe('parseNativeChatVisualDirectiveLine', () => {
  it('parses a workspace path and title', () => {
    expect(
      parseNativeChatVisualDirectiveLine(
        '::orca-visual{path="reports/usage.html" title="Usage by day"}'
      )
    ).toEqual({ path: 'reports/usage.html', title: 'Usage by day' })
  })

  it("shows an older host's `file` line as text: that per-chat folder is gone", () => {
    expect(parseNativeChatVisualDirectiveLine('::orca-visual{file="usage-3f2a.html"}')).toBeNull()
    expect(
      parseNativeChatVisualDirectiveLine('::orca-visual{file="old.html" path="new/page.htm"}')
    ).toEqual({ path: 'new/page.htm', title: null })
  })

  it('treats title as optional and trims it', () => {
    expect(parseNativeChatVisualDirectiveLine('::orca-visual{path="a.html"}')).toEqual({
      path: 'a.html',
      title: null
    })
    expect(parseNativeChatVisualDirectiveLine('::orca-visual{path="a.html" title="  "}')).toEqual({
      path: 'a.html',
      title: null
    })
  })

  it('accepts attributes in any order, with spaces and tabs around them', () => {
    expect(
      parseNativeChatVisualDirectiveLine('::orca-visual{ \ttitle="T"   path="a.html"\t }')
    ).toEqual({ path: 'a.html', title: 'T' })
  })

  it('accepts up to 3 leading spaces, trailing whitespace, and CRLF or LF endings', () => {
    expect(parseNativeChatVisualDirectiveLine('   ::orca-visual{path="a.html"}  \t\r\n')).toEqual({
      path: 'a.html',
      title: null
    })
    expect(parseNativeChatVisualDirectiveLine('::orca-visual{path="a.html"}\n')).not.toBeNull()
    expect(parseNativeChatVisualDirectiveLine('    ::orca-visual{path="a.html"}')).toBeNull()
    expect(parseNativeChatVisualDirectiveLine('\t::orca-visual{path="a.html"}')).toBeNull()
  })

  it('ignores unknown attributes but refuses a repeated one', () => {
    expect(parseNativeChatVisualDirectiveLine('::orca-visual{path="a.html" height="300"}')).toEqual(
      { path: 'a.html', title: null }
    )
    expect(
      parseNativeChatVisualDirectiveLine('::orca-visual{path="a.html" path="b.html"}')
    ).toBeNull()
    expect(
      parseNativeChatVisualDirectiveLine('::orca-visual{path="a.html" title="x" title="y"}')
    ).toBeNull()
  })

  it('keeps braces and markdown characters in a title verbatim', () => {
    expect(
      parseNativeChatVisualDirectiveLine(
        '::orca-visual{path="a.html" title="Cost {USD} *by* <team>"}'
      )
    ).toEqual({ path: 'a.html', title: 'Cost {USD} *by* <team>' })
  })

  it.each([
    ['missing path', '::orca-visual{title="T"}'],
    ['empty braces', '::orca-visual{}'],
    ['no braces', '::orca-visual'],
    ['unclosed', '::orca-visual{path="a.html"'],
    ['text after the line', '::orca-visual{path="a.html"} see above'],
    ['text before the marker', 'Chart: ::orca-visual{path="a.html"}'],
    ['wrong case', '::Orca-Visual{path="a.html"}'],
    ['single quotes', "::orca-visual{path='a.html'}"],
    ['unquoted value', '::orca-visual{path=a.html}'],
    ['escaped quote', '::orca-visual{path="a.html" title="say \\"hi\\""}'],
    ['backslash', '::orca-visual{path="a.html" title="a\\b"}'],
    ['control character', '::orca-visual{path="a.html" title="a\u0007b"}'],
    ['attributes glued together', '::orca-visual{path="a.html"title="T"}'],
    ['uppercase key', '::orca-visual{PATH="a.html"}'],
    ['embedded newline', '::orca-visual{path="a.html"\ntitle="T"}'],
    ['three colons', ':::orca-visual{path="a.html"}']
  ])('refuses %s', (_name, line) => {
    expect(parseNativeChatVisualDirectiveLine(line)).toBeNull()
  })

  it('refuses lines and titles past their length caps', () => {
    const title = 'x'.repeat(NATIVE_CHAT_VISUAL_TITLE_MAX_LENGTH)
    expect(
      parseNativeChatVisualDirectiveLine(`::orca-visual{path="a.html" title="${title}"}`)
    ).not.toBeNull()
    expect(
      parseNativeChatVisualDirectiveLine(`::orca-visual{path="a.html" title="${title}x"}`)
    ).toBeNull()
    const padding = ' '.repeat(NATIVE_CHAT_VISUAL_DIRECTIVE_MAX_LINE_LENGTH)
    expect(parseNativeChatVisualDirectiveLine(`::orca-visual{path="a.html"}${padding}`)).toBeNull()
  })
})

describe('streaming tail', () => {
  it.each([
    ':',
    '::',
    '::orca',
    '::orca-visual{',
    '::orca-visual{path="a.ht',
    '  ::orca-visual{path="a.html"}'
  ])('holds back %j', (line) => {
    expect(isPendingNativeChatVisualDirectiveTail(line)).toBe(true)
  })

  it.each([
    '',
    '   ',
    'Here is a chart:',
    '::other',
    '::orca-visualx',
    '    ::orca-visual{',
    '- ::orca'
  ])('does not hold back %j', (line) => {
    expect(isPendingNativeChatVisualDirectiveTail(line)).toBe(false)
  })

  it('drops only the pending final line', () => {
    expect(withoutPendingNativeChatVisualDirectiveTail('Intro\n::orca-visual{path="a')).toBe(
      'Intro\n'
    )
    expect(withoutPendingNativeChatVisualDirectiveTail('::orca-vis')).toBe('')
    expect(withoutPendingNativeChatVisualDirectiveTail('Intro\nMore text')).toBe('Intro\nMore text')
    // A finished line (followed by a newline) is no longer the tail.
    expect(withoutPendingNativeChatVisualDirectiveTail('::orca-visual{path="a.html"}\n')).toBe(
      '::orca-visual{path="a.html"}\n'
    )
  })
})

describe('withoutNativeChatVisualDirectiveLines', () => {
  const LINE = '::orca-visual{path="usage.html" title="Usage"}'

  it('drops visual lines and the blank lines they leave behind', () => {
    expect(withoutNativeChatVisualDirectiveLines(`Here it is.\n\n${LINE}\n\nTuesday peaked.`)).toBe(
      'Here it is.\n\nTuesday peaked.'
    )
    expect(withoutNativeChatVisualDirectiveLines(`Intro\r\n${LINE}\r\n`)).toBe('Intro')
    expect(withoutNativeChatVisualDirectiveLines(LINE)).toBe('')
  })

  it('keeps the line inside fenced code and anything that is not a whole directive line', () => {
    const fenced = `\`\`\`\n${LINE}\n\`\`\`\nafter`
    expect(withoutNativeChatVisualDirectiveLines(fenced)).toBe(fenced)
    const tilde = `~~~~\n${LINE}\n~~~\nstill code\n~~~~`
    expect(withoutNativeChatVisualDirectiveLines(tilde)).toBe(tilde)
    expect(withoutNativeChatVisualDirectiveLines(`> ${LINE}`)).toBe(`> ${LINE}`)
    expect(withoutNativeChatVisualDirectiveLines(`See ${LINE}`)).toBe(`See ${LINE}`)
  })

  it('follows CommonMark fence rules: no info string on a closer, no backtick in an opener', () => {
    // ```js inside a block does not close it, so the visual line is still code.
    const notClosed = `\`\`\`\n\`\`\`js\n${LINE}\n\`\`\``
    expect(withoutNativeChatVisualDirectiveLines(notClosed)).toBe(notClosed)
    // Inline triple backticks open no fence, so a later visual line is still dropped.
    expect(withoutNativeChatVisualDirectiveLines(`Use \`\`\`a\`\`\` inline\n${LINE}`)).toBe(
      'Use ```a``` inline'
    )
  })

  it('leaves code blocks and indentation as written for a copy', () => {
    const code = '```\na\n\n\n\nb\n```'
    expect(withoutNativeChatVisualDirectiveLines(`${code}\n\n${LINE}`)).toBe(code)
    expect(withoutNativeChatVisualDirectiveLines(`    code\npara\n${LINE}`)).toBe('    code\npara')
    expect(withoutNativeChatVisualDirectiveLines(`${LINE}\n\nText`)).toBe('Text')
  })

  it('returns text without a marker untouched', () => {
    expect(withoutNativeChatVisualDirectiveLines('  plain\n\n\n text  ')).toBe(
      '  plain\n\n\n text  '
    )
  })
})

describe('isNativeChatVisualPath', () => {
  it('accepts relative html paths with nested folders', () => {
    for (const path of [
      'a.html',
      'reports/2026/usage.HTM',
      'out/chart.v2.html',
      'my report.html'
    ]) {
      expect(isNativeChatVisualPath(path)).toBe(true)
    }
  })

  it('refuses absolute, home, drive, dot, empty and non-html paths', () => {
    for (const path of [
      '',
      '/etc/page.html',
      '~/page.html',
      'C:/page.html',
      '../page.html',
      'a/../page.html',
      './page.html',
      'a//page.html',
      'reports/',
      'page.htmlx',
      'page.md',
      'page.html:stream',
      'con/page.html',
      'reports/nul.html'
    ]) {
      expect(isNativeChatVisualPath(path)).toBe(false)
    }
  })

  it('caps the length', () => {
    const long = `${'a'.repeat(NATIVE_CHAT_VISUAL_PATH_MAX_LENGTH - 5)}.html`
    expect(isNativeChatVisualPath(long)).toBe(true)
    expect(isNativeChatVisualPath(`a${long}`)).toBe(false)
  })
})
