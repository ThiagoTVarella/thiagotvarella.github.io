// Demo content: plausible 1978 diary material so the whole app can be explored with no
// tapes, no API key, and no spend. Everything here is invented.

const seg = (i, gr, en, opts = {}) => ({
  id: 's' + i, gr, en,
  start: 12 + i * 27 + (i % 3) * 4,
  confidence: opts.conf ?? 0.86,
  unsure: opts.unsure || null,     // English substring to mark as uncertain
  names: opts.names || []
});

export const TAPES = [
  {
    id: 'tape-001', label: 'Μάρτιος 1978 — Α', side: 'A', minutes: 46,
    status: 'done', cost: 0.42, date: '1978-03-14',
    heading: 'Tuesday, 14 March 1978',
    segments: [
      seg(0, 'Σήμερα είναι Τρίτη, δεκατέσσερις Μαρτίου, χίλια εννιακόσια εβδομήντα οκτώ.',
             'Today is Tuesday, the fourteenth of March, nineteen seventy-eight.'),
      seg(1, 'Ξύπνησα νωρίς, πριν βγει ο ήλιος. Ο καιρός γύρισε πάλι στη βροχή.',
             'I woke early, before the sun was up. The weather has turned to rain again.'),
      seg(2, 'Ήρθε ο Κώστας το μεσημέρι και φέραμε τα ξύλα από την αποθήκη.',
             'Kostas came at midday and we brought the wood in from the shed.',
             { names: ['Kostas'] }),
      seg(3, 'Η Ελένη δεν ήταν καλά όλη την εβδομάδα. Λέει πως είναι τα δόντια της, αλλά εγώ ανησυχώ.',
             'Eleni has not been well all week. She says it is her teeth, but I worry.',
             { names: ['Eleni'] }),
      seg(4, 'Το απόγευμα κάθισα στην αυλή και άκουγα το ραδιόφωνο. Μιλούσαν πάλι για την Κύπρο.',
             'In the afternoon I sat in the yard and listened to the radio. They were talking about Cyprus again.'),
      seg(5, 'Δεν ξέρω τι να πιστέψω πια από αυτά που λένε.',
             'I no longer know what to believe of what they say.', { conf: 0.61 }),
      seg(6, 'Ο μικρός έγραψε από τη Θεσσαλονίκη. Λέει πως τα μαθήματα πάνε καλά.',
             'The little one wrote from Thessaloniki. He says his studies are going well.',
             { names: ['Thessaloniki'] }),
      seg(7, 'Θα του στείλω λεφτά την άλλη βδομάδα, αν προλάβω στην τράπεζα.',
             'I will send him money next week, if I get to the bank in time.'),
      seg(8, 'Απόψε το γόνατο με πονάει περισσότερο από συνήθως. Θα πάω για ύπνο νωρίς.',
             'Tonight my knee hurts more than usual. I will go to bed early.')
    ]
  },
  {
    id: 'tape-002', label: 'Μάρτιος 1978 — Β', side: 'B', minutes: 44,
    status: 'done', cost: 0.40, date: '1978-03-15',
    heading: 'Wednesday, 15 March 1978',
    segments: [
      seg(0, 'Τετάρτη. Ο καιρός καλύτερος σήμερα, βγήκε λίγο ήλιος το πρωί.',
             'Wednesday. Better weather today; a little sun came out in the morning.'),
      seg(1, 'Πήγα στην αγορά και βρήκα τον γέρο τον Παναγιώτη έξω από το καφενείο.',
             'I went to the market and found old Panagiotis outside the coffee house.',
             { names: ['Panagiotis'] }),
      seg(2, 'Μου είπε για τον αδελφό του που έφυγε στη Γερμανία το εξήντα τρία και δεν γύρισε ποτέ.',
             'He told me about his brother who left for Germany in sixty-three and never came back.'),
      seg(3, 'Κάτι είπε για ένα χωριό κοντά στη Καλαμάτα αλλά δεν άκουσα καλά.',
             'He said something about a village near Kalamata but I did not hear well.',
             { conf: 0.44, unsure: 'a village near Kalamata', names: ['Kalamata'] }),
      seg(4, 'Η Ελένη μαγείρεψε φασόλια. Φάγαμε νωρίς και μετά καθίσαμε χωρίς να μιλάμε.',
             'Eleni cooked beans. We ate early and afterwards sat without speaking.',
             { names: ['Eleni'] }),
      seg(5, 'Δεν είναι κακό αυτό. Ύστερα από σαράντα χρόνια, η σιωπή είναι κι αυτή κουβέντα.',
             'That is not a bad thing. After forty years, silence is its own kind of conversation.')
    ]
  },
  {
    id: 'tape-003', label: 'Απρίλιος 1978 — Α', side: 'A', minutes: 51,
    status: 'working', progress: 0.62, cost: 0.28, date: '1978-04-02',
    heading: 'Sunday, 2 April 1978', segments: []
  },
  { id: 'tape-004', label: 'Καλοκαίρι 1979 (?)', side: 'A', minutes: 48,
    status: 'queued', cost: 0, date: null, heading: null, segments: [] }
];

// Names awaiting her confirmation. She hears the audio and types what she hears; the
// Greek spelling is the tool's problem, never hers.
export const PENDING = [
  { id: 'n1', greek: 'Παναγιώτης', heard: 31, guess: 'Panagiotis', kind: 'word',
    context: ['I went to the market and found old ', ' outside the coffee house.'],
    tape: 'tape-002', at: 41 },
  { id: 'n2', greek: 'Γκόστα', heard: 12, guess: 'Kostas', kind: 'word',
    context: ['', ' came at midday and we brought the wood in from the shed.'],
    tape: 'tape-001', at: 66,
    hint: 'This may be the same name as Κώστας, misheard by the tape.' },
  { id: 'n3', greek: 'Καλαμάτα', heard: 4, guess: 'Kalamata', kind: 'word',
    context: ['He said something about a village near ', ' but I did not hear well.'],
    tape: 'tape-002', at: 105 },
  // Not a name at all -- the tape simply blurred a phrase. She cannot spell the Greek,
  // but she CAN say whether the English reads sensibly, so the question changes shape.
  { id: 'n4', greek: 'στο περβόλι του μπαρμπα-Γιώργη', heard: 1, kind: 'phrase',
    guess: 'in old man Giorgis\' orchard',
    context: ['We spent the whole morning ', ', pruning what was left after the frost.'],
    tape: 'tape-002', at: 402,
    hint: 'The tape drops out for about a second here.' },
  { id: 'n5', greek: 'Ζάππειο', heard: 6, guess: 'Zappeion', kind: 'word',
    context: ['We walked as far as the ', ' and sat until it got dark.'],
    tape: 'tape-001', at: 233 }
];

// Notes are hers alone. The tool never infers who anyone is, how they are related, or
// even WHAT they are: `kind` records only whether the tape blurred a single word or a
// longer stretch. A plausible invented detail in a family archive is worse than a blank,
// because nobody would think to check it.
export const GLOSSARY = [
  { id: 'g1', english: 'Eleni', greek: 'Ελένη', kind: 'word', heard: 84, note: '' },
  { id: 'g2', english: 'Kostas', greek: 'Κώστας', kind: 'word', heard: 47, note: '' },
  { id: 'g3', english: 'Thessaloniki', greek: 'Θεσσαλονίκη', kind: 'word', heard: 19, note: '' }
];
