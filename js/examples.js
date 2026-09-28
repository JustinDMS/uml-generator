(function () {
  'use strict';
  const P2U = (globalThis.P2U = globalThis.P2U || {});

  // Examples are written with 4-space groups here for readability, but the
  // editor indents with tabs, so convert leading groups to tabs.
  const tabs = (s) => s.replace(/^(?: {4})+/gm, (m) => '\t'.repeat(m.length / 4));

  P2U.examples = [
    {
      name: 'Fibonacci trace (recursion)',
      source: `DEF Fibonacci Trace
    START
    include input.hpp
    define n = getInput()
    fib(n, 0)
    END

    // A DEF is a definition: it runs where it's called.
    DEF fib(n, d)
        START
        print Enter
        IF n <= 1
            print Exit
            END
        fib(n - 1, d + 1) + fib(n - 2, d + 1)
        print Exit
        END
`,
    },
    {
      name: 'Checkout (calls)',
      source: `DEF Checkout
    START
    validate cart
    takePayment(order)
    fulfil(order)
    send receipt
    END

    DEF takePayment(order)
        START
        charge card
        IF payment declined
            notify customer
            END
        record transaction
        END

    DEF fulfil(order)
        START
        FOR item IN order
            pick item
        pack and ship parcel
        END
`,
    },
    {
      name: 'Linear search',
      source: `DEF LinearSearch
    START
    read list and target
    FOR i IN 1..length(list)
        IF list[i] == target
            END i
    END -1
`,
    },
    {
      name: 'Grade classifier (elif)',
      source: `DEF ClassifyGrade
    START
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
    END
`,
    },
    {
      name: 'Login attempts (do-while)',
      source: `DEF Login
    START
    attempts = 0
    DO
        prompt for username and password
        attempts = attempts + 1
    WHILE credentials are invalid AND attempts < 3
    IF credentials are valid
        open dashboard
    ELSE
        lock account
        END
    log session start
    END
`,
    },
    {
      name: 'Nested loops (bubble sort)',
      source: `DEF BubbleSort
    START
    swapped = true
    WHILE swapped
        swapped = false
        FOR EACH adjacent pair (a, b) IN list
            IF a > b
                swap a and b
                swapped = true
    output list
    END
`,
    },
    {
      name: 'Digit sum (while)',
      source: `DEF DigitSum
    START
    read n
    total = 0
    WHILE n > 0
        total = total + n mod 10
        n = n div 10
    IF total mod 3 == 0
        print "divisible by 3"
    ELSE
        print "not divisible by 3"
    END
`,
    },
  ].map((ex) => ({ ...ex, source: tabs(ex.source) }));
})();
