window.SEED_DECKS = [
  {
    "title": "LR Question Types",
    "description": "Logical Reasoning question types: typical stem wording, what each asks, and how to attack it. LR is two scored sections of the current LSAT (since August 2024).",
    "cards": [
      {
        "term": "Strengthen - 'Which one of the following, if true, most strengthens the argument?'",
        "definition": "Find the answer that makes the conclusion more likely to follow from the premises. Identify the gap between premises and conclusion, then pick the new fact that closes or narrows it; it need not prove the conclusion."
      },
      {
        "term": "Weaken - 'Which one of the following, if true, most seriously weakens the argument?'",
        "definition": "Find the answer that makes the conclusion less likely given the premises. Accept the premises as true; attack the gap, e.g. an alternative cause, a non-representative sample, or a broken analogy."
      },
      {
        "term": "Necessary Assumption - 'The argument relies on/requires assuming which one of the following?'",
        "definition": "Find a statement that must be true for the argument to work. Use the Negation Test: negate the answer; if the argument falls apart, it is necessary. Correct answers are often modest ('at least some', 'not all')."
      },
      {
        "term": "Sufficient Assumption - 'The conclusion follows logically if which one of the following is assumed?'",
        "definition": "Find a premise that, added to the argument, guarantees the conclusion. Map premises and conclusion conditionally and link the new term in the conclusion to the premises. Answers are often strong ('all', 'any', 'only')."
      },
      {
        "term": "Flaw - 'The reasoning in the argument is flawed because the argument...'",
        "definition": "Describe the error in the reasoning. Identify the conclusion and why the premises fail to support it, predict the flaw (e.g. causation, sampling, sufficient/necessary), then match it to the abstract wording in the answers."
      },
      {
        "term": "Parallel Reasoning - 'Which one of the following arguments is most similar in its reasoning to the argument above?'",
        "definition": "Find the answer with the same logical structure (and same conclusion strength/type). Compare conclusions first (certainty, conditional vs. causal, recommendation), then diagram the structure. Topic does not matter."
      },
      {
        "term": "Parallel Flaw - 'Which one of the following exhibits flawed reasoning most similar to that in the argument above?'",
        "definition": "Identify the stimulus's specific flaw, then find the answer that commits the same flaw in the same way. Eliminate valid arguments and answers with a different flaw."
      },
      {
        "term": "Method of Reasoning - 'The argument proceeds by...' / 'The author responds to X by...'",
        "definition": "Describe how the argument is built, abstractly. Identify the conclusion and how each premise supports it; reject answers that describe something the argument does not actually do."
      },
      {
        "term": "Role of a Statement - 'The claim that X plays which one of the following roles in the argument?'",
        "definition": "Identify the function of a specific statement: main conclusion, intermediate (sub)conclusion, premise, background, counterpoint/opposing view, or example. Find the main conclusion first, then place the claim relative to it."
      },
      {
        "term": "Main Point - 'Which one of the following most accurately expresses the conclusion drawn in the argument?'",
        "definition": "Find the main conclusion: the claim everything else supports. Use the 'why?' test and conclusion indicators (thus, therefore, but, however). The answer should restate it, not a premise or a subconclusion."
      },
      {
        "term": "Must Be True / Inference - 'If the statements above are true, which one of the following must also be true?'",
        "definition": "Choose the answer guaranteed by the stimulus. Treat the stimulus as facts (usually no conclusion); combine conditionals and quantifiers. Wrong answers go beyond what was said; never bring in outside information."
      },
      {
        "term": "Most Strongly Supported - 'The statements above most strongly support which one of the following?'",
        "definition": "Choose the answer best supported by the facts, even if not 100% guaranteed. Prefer modest, closely tied answers; reject strong or extreme claims and new information."
      },
      {
        "term": "Principle (Identify / Justify) - 'Which one of the following principles, if valid, most helps to justify the reasoning above?'",
        "definition": "Find a general rule that, applied to the facts, supports the conclusion. Works like a sufficient assumption: the principle's trigger should match the facts and its result should match the conclusion."
      },
      {
        "term": "Principle (Apply / Conform) - 'Which one of the following judgments conforms most closely to the principle stated above?'",
        "definition": "Given a principle in the stimulus, pick the situation that correctly applies it. Diagram the principle as a conditional; the answer must satisfy the sufficient condition and reach the stated outcome (watch for reversals)."
      },
      {
        "term": "Resolve the Paradox - 'Which one of the following, if true, most helps to resolve the apparent discrepancy described above?'",
        "definition": "Explain how two seemingly conflicting facts can both be true. Find the precise conflict; the right answer is a new fact that reconciles them. Do not pick answers that only deepen the conflict or address one side."
      },
      {
        "term": "Point at Issue (Disagree) - 'X and Y disagree over whether...'",
        "definition": "Find the claim one speaker affirms and the other denies. Use the Agree/Disagree test: both speakers must have an opinion on the answer and those opinions must be opposite."
      },
      {
        "term": "Point of Agreement - 'X and Y are committed to agreeing with which one of the following?'",
        "definition": "Find a claim both speakers explicitly or necessarily accept. Each speaker must have expressed a view on the claim, and both views must be the same."
      },
      {
        "term": "Evaluate - 'Which one of the following would be most useful to know in order to evaluate the argument?'",
        "definition": "Find a question whose answer would strengthen the argument one way and weaken it the other way. Test both possible answers (yes/no); the right one is relevant to the gap."
      },
      {
        "term": "Cannot Be True - 'If the statements above are true, which one of the following CANNOT be true?'",
        "definition": "Find the answer that contradicts the stimulus. Four answers could be true; the correct one is impossible given the facts (often violates a conditional or quantifier)."
      },
      {
        "term": "Except questions - '...EXCEPT:' (e.g. 'Each of the following weakens the argument EXCEPT:')",
        "definition": "Four answers do the stated task; the correct answer does not (it may do the opposite or be irrelevant). Restate the task in reverse before answering, e.g. 'find the one that does NOT weaken'."
      },
      {
        "term": "Argument Part / Technique in dialogue - 'Y responds to X by...'",
        "definition": "A Method question about a two-speaker stimulus. Determine X's conclusion and exactly how Y engages it: counterexample, attacking a premise, pointing out an alternative explanation, etc."
      },
      {
        "term": "Flawed principle / Principle violation - 'Which one of the following violates the principle?'",
        "definition": "Diagram the principle; the answer is a case that triggers the sufficient condition but fails the necessary one (or otherwise contradicts the rule)."
      },
      {
        "term": "Conclusion indicators",
        "definition": "Words that usually introduce the conclusion: therefore, thus, hence, so, consequently, accordingly, it follows that, clearly, which shows that, we can conclude that. 'But'/'however' often signal the author's own conclusion after an opposing view."
      },
      {
        "term": "Premise indicators",
        "definition": "Words that usually introduce support: because, since, for, given that, as, after all, due to, in light of the fact that, for the reason that, this is shown by."
      },
      {
        "term": "General LR approach",
        "definition": "Read the question stem first to know the task, then read the stimulus actively: find the conclusion, premises, and gap. Predict an answer before reading choices, then eliminate. Budget roughly 1 min 20 s per question (35 minutes, about 25-26 questions)."
      }
    ]
  },
  {
    "title": "Common Logical Flaws",
    "description": "Reasoning errors that appear in Flaw, Parallel Flaw, Weaken and Strengthen questions.",
    "cards": [
      {
        "term": "Correlation vs. causation",
        "definition": "Concluding that A causes B just because A and B occur together. Ignores alternative causes, reverse causation (B causes A), or coincidence. Weaken by showing another cause or reversed direction."
      },
      {
        "term": "Unrepresentative sample",
        "definition": "Drawing a conclusion about a group from a sample that is too small, biased, or self-selected (e.g. surveying only gym members about exercise habits of all adults)."
      },
      {
        "term": "Ad hominem",
        "definition": "Attacking the person making a claim (character, motives, hypocrisy, interests) instead of the claim or argument itself."
      },
      {
        "term": "Circular reasoning (begging the question)",
        "definition": "The conclusion is assumed in the premises; the argument restates its conclusion as support instead of giving independent evidence."
      },
      {
        "term": "Equivocation",
        "definition": "Using a key word in two different senses in the same argument (e.g. 'theory' as hunch vs. scientific theory), so the premises and conclusion do not actually connect."
      },
      {
        "term": "Part-to-whole (composition)",
        "definition": "Assuming that what is true of the parts must be true of the whole (e.g. every player is excellent, so the team is excellent)."
      },
      {
        "term": "Whole-to-part (division)",
        "definition": "Assuming that what is true of the whole must be true of each part (e.g. the company is profitable, so every division is profitable)."
      },
      {
        "term": "Confusing sufficient and necessary (mistaken reversal)",
        "definition": "Treating a necessary condition as if it were sufficient, or vice versa. From 'A -> B' wrongly concluding 'B -> A'. Stem wording: 'takes for granted that X is required for Y' / 'mistakes a condition sufficient for...'"
      },
      {
        "term": "Mistaken negation",
        "definition": "From 'A -> B' wrongly concluding 'not A -> not B'. E.g. 'If it rains the game is canceled; it didn't rain, so the game wasn't canceled.'"
      },
      {
        "term": "False dichotomy (false choice)",
        "definition": "Assuming only two options exist when others are possible, then concluding one must be true because the other is false."
      },
      {
        "term": "Appeal to authority (inappropriate)",
        "definition": "Relying on a source whose expertise is irrelevant to the claim, or treating an expert's opinion as proof rather than evidence."
      },
      {
        "term": "Appeal to popularity / majority",
        "definition": "Concluding a claim is true or a course of action is good because many people believe or do it."
      },
      {
        "term": "Absence of evidence (appeal to ignorance)",
        "definition": "Treating lack of proof that X is true as proof that X is false (or vice versa). 'No one has shown it is safe, so it is dangerous.'"
      },
      {
        "term": "Straw man",
        "definition": "Misrepresenting an opponent's position as weaker or more extreme than it is, then refuting that distorted version."
      },
      {
        "term": "Percentages vs. numbers",
        "definition": "Drawing conclusions about absolute amounts from percentages or rates (or vice versa) without knowing the base size. A higher rate does not mean a higher number, and more cases does not mean a higher rate."
      },
      {
        "term": "Hasty generalization / anecdotal evidence",
        "definition": "Generalizing from one or a few cases, e.g. a single personal story, to a broad conclusion."
      },
      {
        "term": "Flawed analogy",
        "definition": "Concluding that two things share a property because they are alike in some other respects, when relevant differences exist."
      },
      {
        "term": "Overlooked alternative explanation",
        "definition": "Concluding a single explanation is correct without ruling out other plausible explanations for the same evidence."
      },
      {
        "term": "Attacking an argument means the conclusion is false",
        "definition": "Concluding a claim is false because one argument for it is bad. A weak argument does not prove the conclusion false; at most the claim is unsupported."
      },
      {
        "term": "Possibility vs. certainty",
        "definition": "Treating something that could happen as if it must happen (or something that is merely unproven as impossible). Watch for 'may' in premises and 'will' in conclusions."
      },
      {
        "term": "Term shift / scope shift",
        "definition": "The conclusion is about something different from what the premises establish (e.g. premises about 'popularity', conclusion about 'quality'). The gap is the unproven link between the two terms."
      },
      {
        "term": "Self-contradiction / inconsistency",
        "definition": "The argument relies on premises or a conclusion that conflict with each other."
      },
      {
        "term": "Temporal / past-to-future",
        "definition": "Assuming that because something was true in the past (or of one time period), it will remain true, ignoring changed conditions."
      },
      {
        "term": "Relative vs. absolute",
        "definition": "Concluding something is good/large/high in absolute terms because it is better/larger/higher than something else (or the reverse)."
      },
      {
        "term": "Tu quoque / hypocrisy",
        "definition": "Rejecting a person's argument because the person does not act consistently with it. A form of ad hominem: hypocrisy does not make the claim false."
      },
      {
        "term": "Ignoring necessary means / plan won't work",
        "definition": "Concluding a plan will achieve a goal without considering whether it is feasible, has drawbacks, or that other conditions needed for success hold."
      },
      {
        "term": "Confusing 'some/most' quantities",
        "definition": "E.g. 'Most A are B and most A are C, so some B are C' is valid, but 'Most A are B and most B are C, so most A are C' is invalid. Quantifiers chained in the wrong order produce invalid inferences."
      }
    ]
  },
  {
    "title": "Conditional Logic & Indicator Words",
    "description": "How indicator words translate into conditional statements (A -> B), valid and invalid inferences, and quantifiers.",
    "cards": [
      {
        "term": "Conditional statement (A -> B)",
        "definition": "A is sufficient for B; B is necessary for A. Whenever A happens, B must happen. Knowing B alone tells you nothing about A."
      },
      {
        "term": "Sufficient condition",
        "definition": "The condition that, if met, guarantees the outcome. It goes on the LEFT of the arrow (the 'trigger')."
      },
      {
        "term": "Necessary condition",
        "definition": "A condition required for the outcome. It goes on the RIGHT of the arrow; its absence guarantees the outcome is absent."
      },
      {
        "term": "Contrapositive",
        "definition": "From A -> B you may validly infer not B -> not A. Reverse AND negate both terms. It is the only valid inference from a single conditional."
      },
      {
        "term": "Mistaken reversal (converse)",
        "definition": "Invalid: from A -> B concluding B -> A."
      },
      {
        "term": "Mistaken negation (inverse)",
        "definition": "Invalid: from A -> B concluding not A -> not B."
      },
      {
        "term": "'If A, then B' / 'When A, B' / 'Whenever A, B'",
        "definition": "A -> B. 'If', 'when', 'whenever', 'every time', 'in any case where' introduce the sufficient condition."
      },
      {
        "term": "'A only if B'",
        "definition": "A -> B. 'Only if' introduces the NECESSARY condition (right side). 'You can vote only if you are registered': vote -> registered."
      },
      {
        "term": "'Unless' / 'without' / 'until'",
        "definition": "'A unless B' = not B -> A (also not A -> B). Rule: negate the term NOT attached to 'unless' and make it sufficient; the 'unless' term becomes necessary. 'Without B, not A' = not B -> not A = A -> B."
      },
      {
        "term": "'All A are B' / 'Every A is B' / 'Any A is B' / 'Each A'",
        "definition": "A -> B. Group terms 'all', 'every', 'any', 'each', 'whoever' introduce the sufficient condition."
      },
      {
        "term": "'No A are B' / 'None of the A are B'",
        "definition": "A -> not B (contrapositive B -> not A). 'No' negates the necessary side; the relationship is symmetric."
      },
      {
        "term": "'Only A are B' / 'Only As can B'",
        "definition": "B -> A. 'Only' (without 'the') introduces the NECESSARY condition. 'Only members may enter': enter -> member."
      },
      {
        "term": "'The only A are B' / 'The only way to A is B'",
        "definition": "A -> B. 'The only' introduces the SUFFICIENT condition: 'The only people admitted are members' = admitted -> member."
      },
      {
        "term": "'Requires' / 'depends on' / 'must' / 'necessary'",
        "definition": "'A requires B' = A -> B. 'Requires', 'depends on', 'necessitates', 'is essential for', 'is needed for' point to the necessary condition (B)."
      },
      {
        "term": "'Is sufficient for' / 'guarantees' / 'ensures'",
        "definition": "'A guarantees B' = A -> B. These introduce the sufficient condition (A) and point to the result (B)."
      },
      {
        "term": "'A if and only if B' (biconditional)",
        "definition": "A <-> B: A -> B AND B -> A. Either both happen or neither does. Also 'only if, and if', 'just in case' in formal statements."
      },
      {
        "term": "'Not both A and B'",
        "definition": "A -> not B (and B -> not A). At most one of them; possibly neither."
      },
      {
        "term": "'Either A or B' (at least one)",
        "definition": "not A -> B (and not B -> A). At least one must hold; both are possible unless the stimulus says 'but not both'."
      },
      {
        "term": "Contrapositive of 'A -> B and C'",
        "definition": "not B or not C -> not A. Negating an 'and' turns it into 'or' (and vice versa)."
      },
      {
        "term": "Contrapositive of 'A or B -> C'",
        "definition": "not C -> not A and not B. If the sufficient side has 'or', each disjunct alone triggers C."
      },
      {
        "term": "Chaining conditionals",
        "definition": "A -> B and B -> C gives A -> C (contrapositive not C -> not A). Link the necessary condition of one rule to the identical sufficient condition of another."
      },
      {
        "term": "'Some'",
        "definition": "At least one, possibly all. 'Some A are B' is reversible (some B are A). Two 'some' statements cannot be combined into an inference."
      },
      {
        "term": "'Most'",
        "definition": "More than half, possibly all. 'Most A are B' is NOT reversible. Two 'most' statements about the same group (most A are B, most A are C) yield 'some B are C'."
      },
      {
        "term": "'Many' / 'several' / 'a few'",
        "definition": "Treat as 'some' (at least one). They do not mean 'most'."
      },
      {
        "term": "'Not all A are B'",
        "definition": "Equivalent to 'some A are not B'. Does not tell you whether some A are B."
      },
      {
        "term": "'None' vs. 'not all'",
        "definition": "'None of A are B' = all A are not B. 'Not all A are B' only means at least one A is not B. Negation of 'all' is 'not all' (= some are not), not 'none'."
      },
      {
        "term": "Negating 'most' / 'some'",
        "definition": "The negation of 'most A are B' is 'half or fewer A are B'. The negation of 'some A are B' is 'no A are B'. Useful for the Negation Test on Necessary Assumption questions."
      },
      {
        "term": "A -> B combined with 'some'",
        "definition": "'Some C are A' + 'A -> B' gives 'some C are B'. Valid: the 'some' must connect to the sufficient side of the conditional."
      }
    ]
  },
  {
    "title": "Reading Comprehension",
    "description": "RC passage types, question types, author's attitude vocabulary, comparative passages and strategy.",
    "cards": [
      {
        "term": "Structure of the RC section",
        "definition": "Typically 4 passage sets per 35-minute section (about 26-28 questions), one of them a comparative-passage set. Passages run about 450-500 words; budget roughly 8-9 minutes per passage including questions."
      },
      {
        "term": "Passage topics",
        "definition": "Law, natural sciences, social sciences, and humanities/arts. Content knowledge is never required; everything needed is in the passage."
      },
      {
        "term": "Comparative reading",
        "definition": "Two shorter passages (Passage A and Passage B) on a related topic. Questions ask how they relate: what both discuss, where they agree or disagree, how one author would respond to the other, or how their purposes/structures differ."
      },
      {
        "term": "Main Point / Main Idea question",
        "definition": "'Which one of the following most accurately expresses the main point of the passage?' Choose the answer that covers the whole passage's central claim - not too narrow (one paragraph) or too broad."
      },
      {
        "term": "Primary Purpose question",
        "definition": "'The primary purpose of the passage is to...' Focus on the verb: describe, argue, evaluate, explain, compare, challenge, defend. The verb must match the author's tone (neutral vs. argumentative)."
      },
      {
        "term": "Specific Detail / Explicit question",
        "definition": "'According to the passage...' / 'The passage states that...' The answer is stated directly. Go back to the text and find the line; do not rely on memory."
      },
      {
        "term": "Inference question",
        "definition": "'The passage suggests / it can be inferred / the author would most likely agree...' The answer must be strongly supported by the text, usually one small step beyond what is stated. Reject extreme or outside information."
      },
      {
        "term": "Author's Attitude / Tone question",
        "definition": "'The author's attitude toward X can best be described as...' Pick from positive/negative/neutral and then the right degree. LSAT authors are usually moderate: 'qualified approval', 'cautious skepticism', not 'contempt'."
      },
      {
        "term": "Function / Role question",
        "definition": "'The author mentions X primarily in order to...' or 'The second paragraph serves to...' Ask why the author included it: example, evidence, counterargument, concession, transition, or qualification."
      },
      {
        "term": "Organization / Structure question",
        "definition": "'Which one of the following best describes the organization of the passage?' Use your paragraph map; check every part of the answer against the order of paragraphs."
      },
      {
        "term": "Analogy / Application question",
        "definition": "'Which one of the following is most analogous to X described in the passage?' Abstract the relevant relationship or principle, then find the answer with the same structure in a new context."
      },
      {
        "term": "Strengthen / Weaken in RC",
        "definition": "'Which one of the following, if true, would most strengthen/undermine the author's claim about X?' Same logic as LR: find the specific claim and its support, then test answers against that claim."
      },
      {
        "term": "Meaning in context / Word in context",
        "definition": "'The word X in line N most nearly means...' Read the surrounding sentences; the right meaning fits the context, often not the most common meaning."
      },
      {
        "term": "Passage map",
        "definition": "Brief note (a few words) for each paragraph's purpose, plus the main point and the author's view. Helps answer structure and locate details quickly without rereading."
      },
      {
        "term": "Viewpoints (who says what)",
        "definition": "Track every voice: the author, critics, scholars, traditional view, new view. Many wrong answers attribute a view to the wrong person."
      },
      {
        "term": "Keywords / structural signals",
        "definition": "Contrast: but, however, yet, although, nevertheless. Continuation: moreover, furthermore, also. Conclusion: thus, therefore. Emphasis/opinion: importantly, unfortunately, surely, clearly. They reveal structure and the author's stance."
      },
      {
        "term": "Typical passage structures",
        "definition": "Old view vs. new view; problem-solution; phenomenon plus competing explanations; thesis plus supporting evidence; description of a person/work plus evaluation."
      },
      {
        "term": "Ambivalent",
        "definition": "Having mixed or conflicting feelings (both positive and negative) toward something. Different from 'indifferent' (no interest)."
      },
      {
        "term": "Equivocal / qualified",
        "definition": "Equivocal: deliberately ambiguous or uncommitted. Qualified: limited or restricted, e.g. 'qualified support' means support with reservations - a very common correct LSAT tone."
      },
      {
        "term": "Skeptical",
        "definition": "Doubtful; not convinced that a claim is true. Often the right description of an author questioning a theory without rejecting it outright."
      },
      {
        "term": "Disdainful / contemptuous / derisive",
        "definition": "Scornful, showing low regard. Usually too extreme to describe an LSAT author's tone."
      },
      {
        "term": "Laudatory / reverent / effusive",
        "definition": "Laudatory: expressing praise. Reverent: deep respect. Effusive: excessively enthusiastic. Usually only the milder positive words fit LSAT passages."
      },
      {
        "term": "Objective / detached / dispassionate",
        "definition": "Neutral, presenting information without taking a side. Fits purely descriptive passages."
      },
      {
        "term": "Didactic / polemical",
        "definition": "Didactic: intended to teach, sometimes preachy. Polemical: a strongly worded attack or controversial argument. Polemical is rarely correct for an LSAT author."
      },
      {
        "term": "Pedantic / dogmatic",
        "definition": "Pedantic: overly concerned with minor details or rules. Dogmatic: asserting opinions as undeniably true. Both are usually wrong-answer traps."
      },
      {
        "term": "Wrong-answer traps in RC",
        "definition": "True but irrelevant to the question; too extreme ('always', 'never', 'proves'); half-right/half-wrong; correct detail from the wrong part of passage; attributing a view to the wrong person; outside knowledge."
      },
      {
        "term": "Reading strategy",
        "definition": "Read actively for structure and viewpoints, not memorizing details. Note the main point and author's attitude after each passage; refer back to the text for every detail question."
      }
    ]
  }
];
