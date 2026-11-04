const memory = {
  title: 'Memory',
  description: 'What JARVIS remembers about you, and how it uses it. Only you can see these.',
  kinds: {
    preference: 'Preference',
    fact: 'Fact',
  },
  sources: {
    user: 'You',
    assistant: 'JARVIS',
  },
  empty: 'JARVIS doesn’t remember anything yet.',
  disabled: 'Memory is turned off. JARVIS neither reads nor saves memories.',
  toggle: {
    label: 'Use memory',
    description:
      'JARVIS includes relevant memories when it plans a request — also when the request goes to an external AI model — and saves new ones when you ask it to remember something.',
  },
  retentionRule:
    'Memories that haven’t changed for {period} are deleted automatically, once a day.',
  retentionKept:
    'Memories are kept until you delete them. Choose a period to have old ones deleted automatically.',
  disabledBanner:
    'Nothing below is used or added while memory is off. Your memories are kept until you delete them.',
  search: {
    label: 'Search memories',
    placeholder: 'Search memories',
    results:
      '{count, plural, =0 {No memories match.} one {# memory matches.} other {# memories match.}}',
    resultsMore: 'More than {count} memories match.',
  },
  add: {
    title: 'Add a memory',
    label: 'New memory',
    placeholder: 'Something JARVIS should know or keep in mind',
    kindLegend: 'Kind of memory',
    kindHint: {
      fact: 'Something true about you, like where you work.',
      preference: 'How you like things done, like aisle seats on flights.',
    },
    save: 'Save memory',
    saved: 'Memory saved',
    count: '{count} / {max}',
    required: 'Write the memory first.',
    tooLong: 'Keep it to {max} characters or fewer.',
  },
  list: {
    title: 'Your memories',
    addedByYou: 'Added by you',
    savedByJarvis: 'Saved by JARVIS',
    viewTask: 'View task',
    added: 'Added {time}',
    edited: 'Edited {time}',
    loading: 'Loading memories…',
    loadMore: 'Show more',
    emptyFull:
      'JARVIS doesn’t remember anything yet. Add a fact or preference above, or ask JARVIS to remember something.',
    noResults: 'No memories match “{query}”.',
    clearSearch: 'Clear search',
  },
  item: {
    editLabel: 'Edit memory: {preview}',
    deleteLabel: 'Delete memory: {preview}',
    editField: 'Memory',
    save: 'Save changes',
    updated: 'Memory updated',
    deleted: 'Memory deleted',
  },
  deleteDialog: {
    title: 'Delete this memory?',
    body: 'JARVIS will forget it. This can’t be undone.',
    confirm: 'Delete memory',
  },
  deleteAll: {
    title: 'Delete all memories',
    description:
      'JARVIS forgets everything on this page. Your tasks, connections and settings stay as they are.',
    button: 'Delete all memories…',
    dialogTitle: 'Delete all memories?',
    counting: 'Counting your memories…',
    countFailed: 'JARVIS couldn’t count your memories.',
    body: '{count, plural, =0 {You have no memories to delete.} one {This permanently deletes your only memory.} other {This permanently deletes all # of your memories.}}',
    consequence: 'JARVIS will no longer use them, and this can’t be undone.',
    confirm: '{count, plural, one {Delete # memory} other {Delete # memories}}',
    done: '{count, plural, =0 {No memories were deleted.} one {Deleted # memory.} other {Deleted # memories.}}',
  },
};

export default memory;
