const fetch = require('node-fetch');
const { Client, Intents } = require('discord.js');

jest.mock('node-fetch');

// simple test for bot.js logic: when upload command is triggered, it should fetch URL and reply

// We can simulate interaction object
const createMockInteraction = (filename) => {
  const replies = [];
  return {
    isCommand: () => true,
    commandName: 'upload',
    options: {
      getString: (name) => filename
    },
    reply: async (msg) => replies.push(msg),
    editReply: async (msg) => replies.push(msg),
    deferReply: async () => replies.push('[deferred]'),
    _replies: replies
  };
};

describe('Discord bot upload command', () => {
  beforeEach(() => {
    fetch.mockClear();
  });

  it('replies with upload URL when API returns a URL', async () => {
    // the bot no longer calls out to fetch; it simply builds a URL using
    // WORKER_URL.  Set that environment variable for determinism.
    process.env.WORKER_URL = 'https://example.com';
    const interaction = createMockInteraction('test.bin');

    const { handleInteraction } = require('../bot');
    await handleInteraction(interaction);

    // first entry is the deferred acknowledgement; the second is the URL reply
    expect(interaction._replies.length).toBeGreaterThanOrEqual(2);
    expect(interaction._replies.some(r => r && r.toString().includes('https://example.com'))).toBe(true);
  });

  it('works when no filename hint is provided', async () => {
    process.env.WORKER_URL = 'https://example.com';
    const interaction = createMockInteraction(null);
    const { handleInteraction } = require('../bot');
    await handleInteraction(interaction);

    expect(interaction._replies.length).toBeGreaterThanOrEqual(2);
    const repliesWithoutDeferred = interaction._replies.filter(r => r !== '[deferred]');
    expect(repliesWithoutDeferred.length).toBeGreaterThanOrEqual(1);
    const reply = repliesWithoutDeferred[0];
    expect(reply).toContain('https://example.com');
    expect(reply).not.toContain('filename=');
  });
});
