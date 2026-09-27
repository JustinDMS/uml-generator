(function () {
  'use strict';
  const P2U = (globalThis.P2U = globalThis.P2U || {});

  // Examples are written with 4-space groups here for readability, but the
  // editor indents with tabs, so convert leading groups to tabs.
  const tabs = (s) => s.replace(/^(?: {4})+/gm, (m) => '\t'.repeat(m.length / 4));

  P2U.examples = [
    {
      name: 'Linear search',
      source: `FRAME LinearSearch
    // Indentation defines blocks.
    read list and target
    FOR i IN 1..length(list)
        IF list[i] == target
            RETURN i
    RETURN -1
`,
    },
    {
      name: 'Grade classifier (elif)',
      source: `FRAME ClassifyGrade
    IF score >= 90
        grade = "A"
    ELIF score >= 80
        grade = "B"
    ELIF score >= 70
        grade = "C"
    ELSE
        grade = "F"
        notify advisor
    print grade
`,
    },
    {
      name: 'Login attempts (do-while)',
      source: `FRAME Login
    attempts = 0
    DO
        prompt for username and password
        attempts = attempts + 1
    WHILE credentials are invalid AND attempts < 3
    IF credentials are valid
        open dashboard
    ELSE
        lock account
        RETURN
    log session start
`,
    },
    {
      name: 'Nested loops (bubble sort)',
      source: `FRAME BubbleSort
    swapped = true
    WHILE swapped
        swapped = false
        FOR EACH adjacent pair (a, b) IN list
            IF a > b
                swap a and b
                swapped = true
    output list
`,
    },
    {
      name: 'Digit sum (while)',
      source: `FRAME DigitSum
    read n
    total = 0
    WHILE n > 0
        total = total + n mod 10
        n = n div 10
    IF total mod 3 == 0
        print "divisible by 3"
    ELSE
        print "not divisible by 3"
`,
    },
  ].map((ex) => ({ ...ex, source: tabs(ex.source) }));
})();
