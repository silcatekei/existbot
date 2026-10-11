const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  ContainerBuilder,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SectionBuilder,
  SeparatorBuilder,
  SlashCommandBuilder,
  TextDisplayBuilder,
} = require('discord.js');
const fs = require('node:fs');
const path = require('node:path');
const store = require('./store');

try {
  process.loadEnvFile();
} catch {
  // No .env file; fall back to real environment variables.
}

// ---- Settings (from .env) -------------------------------------------------

const TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID || null;
// Roles that mark someone as a compe team player, e.g. the XST team roles.
const TEAM_ROLE_IDS = (process.env.TEAM_ROLE_IDS ?? '').split(',').map((id) => id.trim()).filter(Boolean);
// Paid games per week for a category that has no cap of its own.
const WEEKLY_CAP = Number(process.env.WEEKLY_CAP || 3);
// Team games per week (all team categories combined) a player needs to avoid the penalty.
const WEEKLY_MINIMUM = Number(process.env.WEEKLY_MINIMUM || 2);
const NO_PRACTICE_PENALTY = Number(process.env.NO_PRACTICE_PENALTY || 100);

// Hours of the day (24h, local time of the machine running the bot) when announcements go out.
const ANNOUNCEMENT_TIMES = [
  { name: '8:00 AM', value: '8' },
  { name: '12:00 PM', value: '12' },
  { name: '7:00 PM', value: '19' },
];
const ANNOUNCEMENTS_PER_TIME = 2;
const DISCORD_MESSAGE_LIMIT = 2000;
// Leaves room in a 2000-character message for the @everyone line and the 📢 prefix.
const MAX_ANNOUNCEMENT_LENGTH = 1900;
// If the bot was offline at the scheduled time, it still posts when it comes back within this window.
const ANNOUNCEMENT_GRACE_MINUTES = 10;

// Compe team scrim rules. Change these numbers to rebalance scrim rewards and penalties.
const SCRIM = {
  lineupSize: 5,
  cap: 10, // paid scrims per player per week
  complete: { win: 500, lose: 100 }, // each player, full 5-man line-up
  incomplete: { win: 100, lose: 20 }, // each present player, incomplete line-up
  sub: 100, // the sub player, win or lose
  cancelPresent: 100, // deducted from each present member when the team cancels
  cancelMissing: 250, // deducted from the missing player when the team cancels
  noScrimPenalty: 100, // each member of a team with no completed scrim that week
  noParticipationPenalty: 200, // a player who joined none of their team's scrims that week
};
// Scrims are stored alongside ranked games under this category key, so it can't be used as a category name.
const SCRIM_KEY = 'scrim';

const MAX_PLAYERS = 5;
const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;

if (!TOKEN) {
  console.error('Missing DISCORD_TOKEN. Copy .env.example to .env and paste your bot token in.');
  process.exit(1);
}

// ---- Slash commands -------------------------------------------------------

const weekOption = (defaultWeek) => (o) =>
  o
    .setName('week')
    .setDescription(`Which week (default: ${defaultWeek} week)`)
    .addChoices({ name: 'This week', value: 'this' }, { name: 'Last week', value: 'last' });

const screenshotOption = (o) =>
  o.setName('screenshot').setDescription('Screenshot of the match result as proof').setRequired(true);

// Everything for the competitive teams lives under /compe; casual players only ever use /casual.
const compeCommand = new SlashCommandBuilder()
  .setName('compe')
  .setDescription('Competitive team perks: ranked games and scrims (staff only)')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommandGroup((g) =>
    g
      .setName('ranked')
      .setDescription('Team ranked games (Duo, Trio, 5 Man)')
      .addSubcommand((s) => {
        s.setName('log')
          .setDescription('Log a team ranked game (Duo, Trio, 5 Man) and pay out ECs')
          .addStringOption((o) =>
            o.setName('category').setDescription('Game category').setRequired(true).setAutocomplete(true),
          )
          .addStringOption((o) =>
            o
              .setName('result')
              .setDescription('Did the team win or lose?')
              .setRequired(true)
              .addChoices({ name: 'Win', value: 'win' }, { name: 'Lose', value: 'lose' }),
          )
          .addAttachmentOption(screenshotOption);
        for (let n = 1; n <= MAX_PLAYERS; n++) {
          s.addUserOption((o) => o.setName(`player${n}`).setDescription(`Player ${n}`).setRequired(n <= 2));
        }
        return s.addStringOption(weekOption('this'));
      })
      .addSubcommand((s) =>
        s.setName('status').setDescription('Show how many ranked games each team player has logged').addStringOption(weekOption('this')),
      )
      .addSubcommand((s) =>
        s
          .setName('penalize')
          .setDescription(`Deduct ${NO_PRACTICE_PENALTY} ECs from team players below the weekly ranked minimum`)
          .addStringOption(weekOption('last')),
      ),
  )
  .addSubcommand((s) => s.setName('undo').setDescription('Undo the most recent ranked game, scrim or casual payout'))
  .addSubcommand((s) => {
    s.setName('teams').setDescription('Choose which roles are the compe teams (leave empty to see the current ones)');
    for (let n = 1; n <= 5; n++) {
      s.addRoleOption((o) => o.setName(`team${n}`).setDescription(`Compe team role ${n}`));
    }
    return s;
  })
  .addSubcommand((s) =>
    s
      .setName('channel')
      .setDescription('Choose the only channel compe games and scrims can be logged in')
      .addChannelOption((o) =>
        o.setName('channel').setDescription('Compe perks channel. Leave empty to clear.').addChannelTypes(ChannelType.GuildText),
      ),
  );

const casualCommand = new SlashCommandBuilder()
  .setName('casual')
  .setDescription('Casual players: claim ECs for a game you played with guildmates (Proof of Alliance)')
  .addStringOption((o) => o.setName('category').setDescription('Game mode').setRequired(true).setAutocomplete(true))
  // Required, so Discord always shows the Win / Lose choice instead of hiding it among optional fields.
  .addStringOption((o) =>
    o
      .setName('result')
      .setDescription('Did you win or lose the game?')
      .setRequired(true)
      .addChoices({ name: 'Win', value: 'win' }, { name: 'Lose', value: 'lose' }),
  )
  .addAttachmentOption(screenshotOption);
for (let n = 1; n < MAX_PLAYERS; n++) {
  casualCommand.addUserOption((o) =>
    o.setName(`guildmate${n}`).setDescription(`Guildmate ${n} you played with`).setRequired(n === 1),
  );
}

const timeOption = (o) =>
  o.setName('time').setDescription('Which daily announcement').setRequired(true).addChoices(...ANNOUNCEMENT_TIMES);
const numberOption = (o) =>
  o
    .setName('number')
    .setDescription('Which of the announcements at that time')
    .setRequired(true)
    .setMinValue(1)
    .setMaxValue(ANNOUNCEMENTS_PER_TIME);

const announceCommand = new SlashCommandBuilder()
  .setName('announce')
  .setDescription('Daily automatic announcements (staff only)')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((s) =>
    s
      .setName('channel')
      .setDescription('Choose the channel announcements are posted in')
      .addChannelOption((o) =>
        o
          .setName('channel')
          .setDescription('Announcement channel')
          .setRequired(true)
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
      ),
  )
  .addSubcommand((s) =>
    s
      .setName('set')
      .setDescription('Set the text of one announcement')
      .addStringOption(timeOption)
      .addIntegerOption(numberOption)
      .addStringOption((o) =>
        o.setName('message').setDescription('The announcement. Type \\n for a new line.').setRequired(true).setMaxLength(MAX_ANNOUNCEMENT_LENGTH),
      ),
  )
  .addSubcommand((s) =>
    s.setName('clear').setDescription('Remove one announcement').addStringOption(timeOption).addIntegerOption(numberOption),
  )
  .addSubcommand((s) => s.setName('list').setDescription('Show the channel and every announcement'))
  .addSubcommand((s) =>
    s.setName('test').setDescription('Post one of the daily announcements right now').addStringOption(timeOption),
  );

compeCommand.addSubcommandGroup((g) =>
  g
    .setName('scrim')
    .setDescription('Team scrims (BO3 and up)')
    .addSubcommand((s) => {
      s.setName('log')
        .setDescription('Log a completed scrim (BO3 or longer) and pay out ECs')
        .addStringOption((o) =>
          o
            .setName('result')
            .setDescription('Did the team win or lose?')
            .setRequired(true)
            .addChoices({ name: 'Win', value: 'win' }, { name: 'Lose', value: 'lose' }),
        )
        .addAttachmentOption(screenshotOption);
      for (let n = 1; n <= SCRIM.lineupSize; n++) {
        s.addUserOption((o) => o.setName(`player${n}`).setDescription(`Team player ${n} who was present`).setRequired(n === 1));
      }
      return s
        .addUserOption((o) => o.setName('sub').setDescription('Sub player who filled in (incomplete line-up only)'))
        .addStringOption((o) => o.setName('against').setDescription('The team you played against').setMaxLength(100))
        .addStringOption(weekOption('this'));
    })
    .addSubcommand((s) => {
      s.setName('cancel')
        .setDescription('Record a scrim the team cancelled because a player was missing')
        .addUserOption((o) => o.setName('missing').setDescription('The missing player').setRequired(true));
      for (let n = 1; n < SCRIM.lineupSize; n++) {
        s.addUserOption((o) => o.setName(`present${n}`).setDescription(`Member ${n} who was present`));
      }
      return s.addStringOption(weekOption('this'));
    })
    .addSubcommand((s) =>
      s.setName('status').setDescription('Show how many scrims each team player has joined').addStringOption(weekOption('this')),
    )
    .addSubcommand((s) =>
      s.setName('penalize').setDescription('Apply the weekly no-scrim penalties to team players').addStringOption(weekOption('last')),
    ),
);

const shopCommand = new SlashCommandBuilder()
  .setName('redeemshop')
  .setDescription('Manage the EC shop (staff only)')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((s) => s.setName('post').setDescription('Post the shop with its redeem buttons in this channel'))
  .addSubcommand((s) =>
    s
      .setName('setup')
      .setDescription('Choose who handles redeem tickets and where they open')
      .addRoleOption((o) => o.setName('staff_role').setDescription('Role that can see and close redeem tickets'))
      .addChannelOption((o) =>
        o.setName('ticket_category').setDescription('Category new tickets are created under').addChannelTypes(ChannelType.GuildCategory),
      )
      .addChannelOption((o) =>
        o.setName('archive_category').setDescription('Category delivered tickets are moved to').addChannelTypes(ChannelType.GuildCategory),
      )
      .addStringOption((o) =>
        o.setName('note').setDescription('Text shown under the item list. Type \\n for a new line.').setMaxLength(1000),
      ),
  )
  .addSubcommand((s) =>
    s
      .setName('additem')
      .setDescription('Add a shop item or change an existing one')
      .addStringOption((o) => o.setName('name').setDescription('Item name, e.g. Epic Skin').setRequired(true).setMaxLength(40))
      .addIntegerOption((o) => o.setName('price').setDescription('Price in ECs').setRequired(true).setMinValue(1))
      .addStringOption((o) => o.setName('description').setDescription('Short text shown next to the item').setMaxLength(300))
      .addIntegerOption((o) => o.setName('stock').setDescription('How many are available (leave empty for unlimited)').setMinValue(0)),
  )
  .addSubcommand((s) =>
    s
      .setName('removeitem')
      .setDescription('Remove a shop item')
      .addStringOption((o) => o.setName('name').setDescription('Item name').setRequired(true).setAutocomplete(true)),
  );

const casualReviewCommand = new SlashCommandBuilder()
  .setName('casualreview')
  .setDescription('Choose the staff channel where /casual claims are approved (staff only)')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addChannelOption((o) =>
    o
      .setName('channel')
      .setDescription('Staff channel for Approve / Reject. Leave empty to approve in the receipts channel again.')
      .addChannelTypes(ChannelType.GuildText),
  );

const casualChannelCommand = new SlashCommandBuilder()
  .setName('casualchannel')
  .setDescription('Choose the only channel /casual claims are accepted in (staff only)')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addChannelOption((o) =>
    o.setName('channel').setDescription('Casual claims channel. Leave empty to clear.').addChannelTypes(ChannelType.GuildText),
  );

const commands = [
  compeCommand,
  casualCommand,
  casualChannelCommand,
  casualReviewCommand,
  shopCommand,
  announceCommand,
  new SlashCommandBuilder()
    .setName('category')
    .setDescription('Manage game categories and their EC rewards')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) =>
      s
        .setName('set')
        .setDescription('Add a category or change an existing one')
        .addStringOption((o) =>
          o.setName('name').setDescription('Category name, e.g. Duo').setRequired(true).setMaxLength(32).setAutocomplete(true),
        )
        .addIntegerOption((o) =>
          o
            .setName('players')
            .setDescription('Players per game (casual categories: the minimum)')
            .setRequired(true)
            .setMinValue(1)
            .setMaxValue(MAX_PLAYERS),
        )
        .addIntegerOption((o) => o.setName('win').setDescription('ECs each player gets for a win').setRequired(true).setMinValue(0))
        .addIntegerOption((o) => o.setName('lose').setDescription('ECs each player gets for a loss').setRequired(true).setMinValue(0))
        .addIntegerOption((o) => o.setName('cap').setDescription('Paid games per player per week').setMinValue(1))
        .addBooleanOption((o) => o.setName('casual').setDescription('Casual mode claimed with /casual? (No = compe team ranked category)'))
        .addChannelOption((o) =>
          o.setName('channel').setDescription('Only accept /casual claims for this category in this channel').addChannelTypes(ChannelType.GuildText),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('remove')
        .setDescription('Delete a category')
        .addStringOption((o) => o.setName('name').setDescription('Category').setRequired(true).setAutocomplete(true)),
    )
    .addSubcommand((s) => s.setName('list').setDescription('Show all categories and rewards')),
  new SlashCommandBuilder()
    .setName('points')
    .setDescription('Manually adjust ECs (staff only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) =>
      s
        .setName('add')
        .setDescription('Give ECs to a member')
        .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true))
        .addIntegerOption((o) => o.setName('amount').setDescription('ECs').setRequired(true).setMinValue(1)),
    )
    .addSubcommand((s) =>
      s
        .setName('remove')
        .setDescription('Take ECs from a member')
        .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true))
        .addIntegerOption((o) => o.setName('amount').setDescription('ECs').setRequired(true).setMinValue(1)),
    ),
  new SlashCommandBuilder()
    .setName('balance')
    .setDescription('Check an EC balance and games played this week')
    .addUserOption((o) => o.setName('user').setDescription('Whose balance to check (default: you)')),
  new SlashCommandBuilder().setName('leaderboard').setDescription('Show the top 10 EC holders'),
].map((c) => c.setContexts(InteractionContextType.Guild).toJSON());

// ---- Helpers --------------------------------------------------------------

const ephemeral = (content) => ({ content, flags: MessageFlags.Ephemeral });
const noPings = { parse: [] };

const categoryKey = (name) => name.toLowerCase().replace(/\s+/g, '');
const capOf = (category) => category.cap ?? WEEKLY_CAP;
const mentions = (userIds) => userIds.map((id) => `<@${id}>`).join(', ');
const headline = (result) => (result === 'win' ? '🏆 WIN' : '💀 LOSE');

// ---- Themed cards ---------------------------------------------------------

// Guild colours: red for results, dark greys for anything waiting or turned down.
const THEME = { red: 0xe10600, silver: 0xb9bbbe, pending: 0x2b2d31, muted: 0x4a4a4f };

const resultTitle = (result, label) => `${result === 'win' ? '🏆 VICTORY' : '💀 DEFEAT'} · ${label}`;

// One player's row on a card, e.g. "@Sho ┃ +50 ECs ┃ game 2/10 ┃ balance 10,400".
const payoutLine = (userId, amount, progress, balance, tag = '') =>
  [
    `<@${userId}>${tag}`,
    `**${amount < 0 ? '-' : '+'}${ecs(Math.abs(amount))}**`,
    progress,
    `balance ${balance.toLocaleString('en-US')}`,
  ]
    .filter(Boolean)
    .join(' ┃ ');

// The screenshot re-uploaded under a plain name, so a card can show it as its image.
const proofFile = (screenshot, url = screenshot.url) => ({
  attachment: url,
  name: `proof${path.extname(screenshot.name ?? '').toLowerCase() || '.png'}`,
});

// Builds the embed every game, scrim and claim result is shown in.
function resultCard(guild, { kind, title, body, status, footer, imageName, color = THEME.red }) {
  const embed = new EmbedBuilder()
    .setColor(color)
    .setAuthor({ name: `${guild.name} • ${kind}`.slice(0, 256), iconURL: guild.iconURL() ?? undefined })
    .setTitle(title)
    .setDescription(body.slice(0, 4000))
    .setFooter({ text: footer })
    .setTimestamp();
  if (status) embed.addFields({ name: 'Status', value: status });
  if (imageName) embed.setImage(`attachment://${imageName}`);
  return embed;
}

const claimBody = (claimantId, playerIds, lines = []) =>
  [`**Claimed by** <@${claimantId}>\n**Players** ${mentions(playerIds)}`, lines.join('\n')].filter(Boolean).join('\n\n');

// Weeks run Monday to Sunday in the local time of the machine running the bot.
// Returns the date of the week's Monday as YYYY-MM-DD.
function weekKey(which) {
  const monday = new Date();
  monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7) - (which === 'last' ? 7 : 0));
  const pad = (n) => String(n).padStart(2, '0');
  return `${monday.getFullYear()}-${pad(monday.getMonth() + 1)}-${pad(monday.getDate())}`;
}

// Returns { [userId]: { [categoryKey]: gamesPlayed } } for one week's games.
function countGames(games) {
  const counts = {};
  for (const game of games) {
    // A cancelled scrim is a penalty record, not a game anyone played.
    if (game.result === 'cancelled') continue;
    for (const userId of game.players) {
      counts[userId] ??= {};
      counts[userId][game.category] = (counts[userId][game.category] ?? 0) + 1;
    }
  }
  return counts;
}

const totalGames = (categoryCounts = {}) => Object.values(categoryCounts).reduce((sum, n) => sum + n, 0);

function describeCounts(categories, categoryCounts = {}) {
  return Object.entries(categories)
    .map(([key, category]) => `${category.label} ${categoryCounts[key] ?? 0}/${capOf(category)}`)
    .join(' · ');
}

// The compe team roles: set in Discord with /compe teams, or in .env as a fallback. Each role is one team.
function teamRoleIds(guildId) {
  const saved = store.getSettings(guildId).teamRoleIds;
  return saved?.length ? saved : TEAM_ROLE_IDS;
}

const isTeamMember = (member) => !member.user.bot && member.roles.cache.hasAny(...teamRoleIds(member.guild.id));

// Shown when a command needs the member list but Discord isn't sending it to the bot.
const MEMBERS_INTENT_HELP =
  'I can\'t see the member list yet. Turn on **Server Members Intent** at https://discord.com/developers/applications ' +
  '(your app → Bot), then restart me.';
const NO_TEAMS_HELP = 'No compe team roles are set yet. Run `/compe teams` and pick the team roles first.';

async function fetchTeamMemberIds(guild) {
  const members = await guild.members.fetch();
  return [...members.filter(isTeamMember).keys()];
}

// Returns an error message if the attachment can't be used as proof, otherwise null.
function screenshotProblem(screenshot) {
  if (!screenshot.contentType?.startsWith('image/')) return 'The screenshot has to be an image file (PNG, JPG, ...).';
  if (screenshot.size > MAX_SCREENSHOT_BYTES) return 'That screenshot is too large. Please use an image under 8 MB.';
  return null;
}

// Reads the user options named in optionNames and checks them against the category's rules.
// Returns { players } on success or { error } with a message for the person running the command.
function collectPlayers(interaction, optionNames, category, players = []) {
  for (const name of optionNames) {
    const user = interaction.options.getUser(name);
    if (!user) continue;
    if (user.bot) return { error: `${user} is a bot and can't be a player.` };
    if (players.some((p) => p.id === user.id)) return { error: `${user} is listed more than once.` };
    if (!category.casual) {
      // Compe perks are only for members with a compe team role.
      if (!teamRoleIds(interaction.guildId).length) return { error: NO_TEAMS_HELP };
      const member = interaction.options.getMember(name);
      if (!(member && isTeamMember(member))) return { error: `${user} isn't on a compe team, so they can't earn compe perks.` };
    }
    players.push(user);
  }

  if (category.casual && players.length < category.players) {
    return { error: `**${category.label}** needs at least ${category.players} guild members in the game.` };
  }
  if (!category.casual && players.length !== category.players) {
    return { error: `**${category.label}** needs exactly ${category.players} players, but you listed ${players.length}.` };
  }
  return { players };
}

// Pays every player for one game (respecting the weekly cap) and records it. Returns one line per player.
function payGame(guildId, { key, category, result, playerIds, week, loggedBy }) {
  const counts = countGames(store.gamesInWeek(guildId, week));
  const cap = capOf(category);

  const paid = {};
  const lines = [];
  for (const userId of playerIds) {
    const gameNumber = (counts[userId]?.[key] ?? 0) + 1;
    if (gameNumber > cap) {
      paid[userId] = 0;
      lines.push(`<@${userId}> ┃ no ECs ┃ weekly cap of ${cap} ${category.label} games reached`);
      continue;
    }
    paid[userId] = category[result];
    const balance = store.addPoints(guildId, userId, paid[userId]);
    lines.push(payoutLine(userId, paid[userId], `game ${gameNumber}/${cap}`, balance));
  }

  store.addGame(guildId, { week, category: key, result, players: playerIds, paid, loggedBy, loggedAt: Date.now() });
  return lines;
}

// ---- Command handlers -----------------------------------------------------

const TEAM_ROLE_OPTIONS = Array.from({ length: 5 }, (_, i) => `team${i + 1}`);

// /compe teams: with roles it saves them as the compe teams; with none it shows the current ones.
async function handleTeams(interaction) {
  const guildId = interaction.guildId;
  const chosen = [...new Set(TEAM_ROLE_OPTIONS.map((name) => interaction.options.getRole(name)?.id).filter(Boolean))];
  if (chosen.length) store.updateSettings(guildId, { teamRoleIds: chosen });

  const current = teamRoleIds(guildId);
  const list = current.map((id) => `<@&${id}>`).join(', ');
  const lines = [
    current.length
      ? `${chosen.length ? '✅ Compe teams saved' : 'Compe teams'}: ${list}\nOnly members with one of these roles can earn compe perks.`
      : NO_TEAMS_HELP,
  ];
  if (!canListMembers) lines.push(`⚠️ ${MEMBERS_INTENT_HELP} Until then the weekly status and penalties won't work.`);
  return interaction.reply({ content: lines.join('\n\n'), allowedMentions: noPings });
}

// Routes /compe to the team setup, ranked-game, scrim and undo handlers.
async function handleCompe(interaction) {
  const group = interaction.options.getSubcommandGroup(false);
  const subcommand = interaction.options.getSubcommand();
  if (!group && subcommand === 'teams') return handleTeams(interaction);
  if (!group && subcommand === 'channel') return handleChannelSetting(interaction, 'compeChannelId', 'Compe team games');
  // Logging a game, scrim or cancellation only happens in the compe perks channel.
  if (['log', 'cancel'].includes(subcommand)) {
    const wrongChannel = wrongCompeChannel(interaction);
    if (wrongChannel) return interaction.reply(ephemeral(wrongChannel));
  }
  if (group === 'scrim') return handleScrim(interaction);
  if (group === 'ranked' && interaction.options.getSubcommand() !== 'log') return handleWeek(interaction);
  return handleGame(interaction);
}

async function handleGame(interaction) {
  const guildId = interaction.guildId;

  if (interaction.options.getSubcommand() === 'undo') {
    const game = store.popLastGame(guildId);
    if (!game) return interaction.reply(ephemeral('There are no paid games to undo.'));

    for (const [userId, amount] of Object.entries(game.paid)) {
      if (amount) store.addPoints(guildId, userId, -amount);
    }
    const label = game.category === SCRIM_KEY ? 'Scrim' : (store.getCategories(guildId)[game.category]?.label ?? game.category);
    return interaction.reply({
      content:
        `↩️ Undid the last entry: **${label}** ${game.result} (week of ${game.week}) with ` +
        `${mentions(Object.keys(game.paid))}. Its EC rewards and penalties were reversed.`,
      allowedMentions: noPings,
    });
  }

  const key = categoryKey(interaction.options.getString('category', true));
  const category = store.getCategories(guildId)[key];
  if (!category) return interaction.reply(ephemeral('Unknown category. Pick one from the list, or add it with `/category set`.'));
  // /compe ranked log is for compe team ranked games only; casual modes go through /casual.
  if (category.casual) {
    return interaction.reply(ephemeral(`**${category.label}** is a casual mode. Players claim it themselves with \`/casual\`.`));
  }

  const playerOptions = Array.from({ length: MAX_PLAYERS }, (_, i) => `player${i + 1}`);
  const { players, error } = collectPlayers(interaction, playerOptions, category);
  if (error) return interaction.reply(ephemeral(error));

  const screenshot = interaction.options.getAttachment('screenshot', true);
  const problem = screenshotProblem(screenshot);
  if (problem) return interaction.reply(ephemeral(problem));

  // Re-uploading the screenshot can take longer than Discord's 3 second reply window.
  await interaction.deferReply();

  const result = interaction.options.getString('result', true);
  const week = weekKey(interaction.options.getString('week') ?? 'this');
  const lines = payGame(guildId, {
    key,
    category,
    result,
    playerIds: players.map((p) => p.id),
    week,
    loggedBy: interaction.user.id,
  });

  // Attach the screenshot to the bot's own message so the proof stays with the payout.
  const proof = proofFile(screenshot);
  const card = resultCard(interaction.guild, {
    kind: 'Compe Team Ranked',
    title: resultTitle(result, category.label),
    body: lines.join('\n'),
    footer: `Week of ${week} • Logged by ${interaction.user.username}`,
    imageName: proof.name,
  });
  return interaction.editReply({ embeds: [card], files: [proof] });
}

// Receipt channels from the Proof of Alliance rules, matched by name when no channel was set with /category set.
const RECEIPT_CHANNEL_NAMES = {
  adventure: 'adventure-alliance-receipts',
  pvp: 'pvp-alliance-receipts',
  ranked: 'ranked-alliance-receipts',
};

// The only channel /casual is accepted in for a category, or null if claims are allowed anywhere.
function findReceiptChannelId(guild, key, category) {
  return (
    category.channelId ??
    store.getSettings(guild.id).casualChannelId ??
    findChannelByName(guild, RECEIPT_CHANNEL_NAMES[key]) ??
    findChannelByName(guild, DEFAULT_CHANNEL_NAMES.casual)
  );
}

// Channels used when none was chosen with /casualchannel or /compe channel.
const DEFAULT_CHANNEL_NAMES = { casual: 'pvp-adventure-ranked-alliance', compe: 'competive-ranked-scrim-perks' };

function findChannelByName(guild, name) {
  // includes() so a channel with an emoji or prefix in front of the name still matches.
  const channel = name && guild.channels.cache.find((c) => c.type === ChannelType.GuildText && c.name.includes(name));
  return channel?.id ?? null;
}

// Returns a message if a compe game is being logged outside the compe perks channel, otherwise null.
function wrongCompeChannel(interaction) {
  const channelId =
    store.getSettings(interaction.guildId).compeChannelId ?? findChannelByName(interaction.guild, DEFAULT_CHANNEL_NAMES.compe);
  if (!channelId || interaction.channelId === channelId) return null;
  return `Please log compe team games in <#${channelId}>.`;
}

// /casualchannel and /compe channel: choose the one channel those games are accepted in.
async function handleChannelSetting(interaction, settingKey, what) {
  const channel = interaction.options.getChannel('channel');
  store.updateSettings(interaction.guildId, { [settingKey]: channel?.id ?? null });
  return interaction.reply(
    channel
      ? `✅ ${what} are now only accepted in ${channel}.`
      : `✅ Channel cleared. ${what} go in the channel named \`${DEFAULT_CHANNEL_NAMES[settingKey === 'compeChannelId' ? 'compe' : 'casual']}\` if it exists, otherwise anywhere.`,
  );
}

async function handleClaim(interaction) {
  const guildId = interaction.guildId;
  const key = categoryKey(interaction.options.getString('category', true));
  const category = store.getCategories(guildId)[key];
  if (!category?.casual) return interaction.reply(ephemeral('Unknown game mode. Pick one from the list.'));

  const receiptChannelId = findReceiptChannelId(interaction.guild, key, category);
  if (receiptChannelId && interaction.channelId !== receiptChannelId) {
    return interaction.reply(ephemeral(`Please send **${category.label}** proof in <#${receiptChannelId}>.`));
  }

  const guildmateOptions = Array.from({ length: MAX_PLAYERS - 1 }, (_, i) => `guildmate${i + 1}`);
  const { players, error } = collectPlayers(interaction, guildmateOptions, category, [interaction.user]);
  if (error) return interaction.reply(ephemeral(error));

  const screenshot = interaction.options.getAttachment('screenshot', true);
  const problem = screenshotProblem(screenshot);
  if (problem) return interaction.reply(ephemeral(problem));

  const week = weekKey('this');
  const alreadyPaid = countGames(store.gamesInWeek(guildId, week))[interaction.user.id]?.[key] ?? 0;
  if (alreadyPaid >= capOf(category)) {
    return interaction.reply(
      ephemeral(`You've already been paid for ${capOf(category)} **${category.label}** games this week, which is the cap.`),
    );
  }

  await interaction.deferReply();

  const result = interaction.options.getString('result', true);
  const playerIds = players.map((p) => p.id);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('claim:approve').setLabel('Approve').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('claim:reject').setLabel('Reject').setStyle(ButtonStyle.Danger),
  );

  const { reviewChannelId } = store.getSettings(guildId);
  const reviewChannel = reviewChannelId ? await interaction.guild.channels.fetch(reviewChannelId).catch(() => null) : null;

  const proof = proofFile(screenshot);
  const pendingCard = (extra = '') =>
    resultCard(interaction.guild, {
      kind: 'Proof of Alliance',
      title: resultTitle(result, category.label),
      body: claimBody(interaction.user.id, playerIds) + extra,
      status: '⏳ Waiting for staff review',
      footer: `Week of ${week}`,
      imageName: proof.name,
      color: THEME.pending,
    });

  // With a review channel, the player's message has no buttons; staff decide on a copy in their own channel.
  const message = await interaction.editReply({
    embeds: [pendingCard()],
    files: [proof],
    components: reviewChannel ? [] : [row],
  });

  let reviewMessage = message;
  let origin = null;
  if (reviewChannel) {
    try {
      reviewMessage = await reviewChannel.send({
        embeds: [pendingCard(`\n\n[Jump to the player's message](${message.url})`)],
        files: [proofFile(screenshot, message.attachments.first()?.url)],
        components: [row],
      });
      origin = { channelId: message.channelId, messageId: message.id };
    } catch (error) {
      // The review channel is unusable, so fall back to buttons on the player's own message.
      console.error('Could not post the claim in the review channel:', error.message);
      await interaction.editReply({ components: [row] });
    }
  }

  // Keyed by the message that carries the buttons; origin is the player's message to update afterwards.
  store.addClaim(guildId, reviewMessage.id, { week, category: key, result, players: playerIds, claimant: interaction.user.id, origin });
}

async function handleClaimReview(interaction) {
  const channel = interaction.options.getChannel('channel');
  store.updateSettings(interaction.guildId, { reviewChannelId: channel?.id ?? null });
  return interaction.reply(
    channel
      ? `✅ New claims will be sent to ${channel} for staff to approve or reject.`
      : '✅ Review channel cleared. Claims are approved on the message in the receipts channel again.',
  );
}

async function handleClaimButton(interaction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    return interaction.reply(ephemeral('Only staff can approve or reject claims.'));
  }

  const guildId = interaction.guildId;
  const claim = store.takeClaim(guildId, interaction.message.id);
  if (!claim) return interaction.reply(ephemeral('This claim was already reviewed.'));

  const category = store.getCategories(guildId)[claim.category];
  const label = category?.label ?? claim.category;

  let status;
  let lines = [];
  if (!category) {
    status = '❌ This category no longer exists. No ECs paid.';
  } else if (interaction.customId === 'claim:reject') {
    status = `❌ Rejected by ${interaction.user}. No ECs paid.`;
  } else {
    lines = payGame(guildId, {
      key: claim.category,
      category,
      result: claim.result,
      playerIds: claim.players,
      week: claim.week,
      loggedBy: interaction.user.id,
    });
    status = `✅ Approved by ${interaction.user}`;
  }

  const card = resultCard(interaction.guild, {
    kind: 'Proof of Alliance',
    title: resultTitle(claim.result, label),
    body: claimBody(claim.claimant, claim.players, lines),
    status,
    footer: `Week of ${claim.week}`,
    // The screenshot is already attached to the message; the card keeps pointing at it.
    imageName: interaction.message.attachments.first()?.name,
    color: lines.length ? THEME.red : THEME.muted,
  });
  // content: '' clears the plain text of claims made before the cards existed.
  const reviewed = { content: '', embeds: [card], components: [] };
  await interaction.update(reviewed);

  // When the buttons were in the staff review channel, show the result on the player's message too.
  if (claim.origin) {
    try {
      const channel = await interaction.guild.channels.fetch(claim.origin.channelId);
      await channel.messages.edit(claim.origin.messageId, reviewed);
    } catch (error) {
      console.error("Could not update the player's claim message:", error.message);
    }
  }
}

// ---- Scrims ---------------------------------------------------------------

// Reads the given user options as team players; however many were filled in is accepted.
function readScrimPlayers(interaction, optionNames) {
  const given = optionNames.filter((name) => interaction.options.getUser(name)).length;
  return collectPlayers(interaction, optionNames, { label: 'Scrim', casual: false, players: given });
}

async function handleScrim(interaction) {
  const subcommand = interaction.options.getSubcommand();
  if (subcommand === 'log') return logScrim(interaction);
  if (subcommand === 'cancel') return cancelScrim(interaction);
  return scrimWeek(interaction, subcommand === 'penalize');
}

async function logScrim(interaction) {
  const guildId = interaction.guildId;
  const playerOptions = Array.from({ length: SCRIM.lineupSize }, (_, i) => `player${i + 1}`);
  const { players, error } = readScrimPlayers(interaction, playerOptions);
  if (error) return interaction.reply(ephemeral(error));

  const complete = players.length === SCRIM.lineupSize;
  const sub = interaction.options.getUser('sub');
  if (sub?.bot) return interaction.reply(ephemeral(`${sub} is a bot and can't be the sub.`));
  if (sub && players.some((p) => p.id === sub.id)) return interaction.reply(ephemeral(`${sub} is listed as both a player and the sub.`));
  if (sub && complete) {
    return interaction.reply(ephemeral(`A complete ${SCRIM.lineupSize}-man line-up has no sub. Remove the sub or the player they replaced.`));
  }

  const screenshot = interaction.options.getAttachment('screenshot', true);
  const problem = screenshotProblem(screenshot);
  if (problem) return interaction.reply(ephemeral(problem));

  await interaction.deferReply();

  const result = interaction.options.getString('result', true);
  const week = weekKey(interaction.options.getString('week') ?? 'this');
  const against = interaction.options.getString('against')?.trim() || null;
  const amount = (complete ? SCRIM.complete : SCRIM.incomplete)[result];
  const counts = countGames(store.gamesInWeek(guildId, week));

  const paid = {};
  const lines = [];
  for (const player of players) {
    const scrimNumber = (counts[player.id]?.[SCRIM_KEY] ?? 0) + 1;
    if (scrimNumber > SCRIM.cap) {
      paid[player.id] = 0;
      lines.push(`${player} ┃ no ECs ┃ weekly cap of ${SCRIM.cap} scrims reached`);
      continue;
    }
    paid[player.id] = amount;
    const balance = store.addPoints(guildId, player.id, amount);
    lines.push(payoutLine(player.id, amount, `scrim ${scrimNumber}/${SCRIM.cap}`, balance));
  }
  if (sub) {
    paid[sub.id] = SCRIM.sub;
    const balance = store.addPoints(guildId, sub.id, SCRIM.sub);
    lines.push(payoutLine(sub.id, SCRIM.sub, null, balance, ' (sub)'));
  }

  // The sub is kept out of "players" so filling in for another team doesn't count as their own team's scrim.
  store.addGame(guildId, {
    week,
    category: SCRIM_KEY,
    result,
    players: players.map((p) => p.id),
    sub: sub?.id ?? null,
    against,
    paid,
    loggedBy: interaction.user.id,
    loggedAt: Date.now(),
  });

  const lineup = complete ? `Complete ${SCRIM.lineupSize}-man` : 'Incomplete line-up';
  const proof = proofFile(screenshot);
  const card = resultCard(interaction.guild, {
    kind: 'Compe Team Scrim',
    title: resultTitle(result, `Scrim · ${lineup}`),
    body: (against ? `**Against** ${against}\n\n` : '') + lines.join('\n'),
    footer: `Week of ${week} • Logged by ${interaction.user.username}`,
    imageName: proof.name,
  });
  return interaction.editReply({ embeds: [card], files: [proof] });
}

async function cancelScrim(interaction) {
  const guildId = interaction.guildId;
  const missing = interaction.options.getUser('missing', true);
  if (missing.bot) return interaction.reply(ephemeral(`${missing} is a bot.`));

  const presentOptions = Array.from({ length: SCRIM.lineupSize - 1 }, (_, i) => `present${i + 1}`);
  const { players: present, error } = readScrimPlayers(interaction, presentOptions);
  if (error) return interaction.reply(ephemeral(error));
  if (present.some((p) => p.id === missing.id)) return interaction.reply(ephemeral(`${missing} is listed as both missing and present.`));

  const week = weekKey(interaction.options.getString('week') ?? 'this');
  const paid = {};
  const lines = [];
  const deduct = (user, amount, label) => {
    paid[user.id] = -amount;
    const balance = store.addPoints(guildId, user.id, -amount);
    lines.push(payoutLine(user.id, -amount, null, balance, label));
  };
  deduct(missing, SCRIM.cancelMissing, ' (missing)');
  for (const member of present) deduct(member, SCRIM.cancelPresent, '');

  store.addGame(guildId, {
    week,
    category: SCRIM_KEY,
    result: 'cancelled',
    players: [missing.id, ...present.map((p) => p.id)],
    paid,
    loggedBy: interaction.user.id,
    loggedAt: Date.now(),
  });
  const card = resultCard(interaction.guild, {
    kind: 'Compe Team Scrim',
    title: '🚫 SCRIM CANCELLED BY TEAM',
    body: lines.join('\n'),
    footer: `Week of ${week} • Logged by ${interaction.user.username}`,
    color: THEME.muted,
  });
  return interaction.reply({ embeds: [card] });
}

// Shows each team's scrim counts for a week, or applies the weekly scrim penalties.
async function scrimWeek(interaction, penalizing) {
  const guildId = interaction.guildId;
  const week = weekKey(interaction.options.getString('week') ?? (penalizing ? 'last' : 'this'));
  if (!teamRoleIds(guildId).length) return interaction.reply(ephemeral(NO_TEAMS_HELP));
  if (!canListMembers) return interaction.reply(ephemeral(MEMBERS_INTENT_HELP));

  await interaction.deferReply();
  const scrims = store.gamesInWeek(guildId, week).filter((game) => game.category === SCRIM_KEY);
  const counts = countGames(scrims);
  const scrimsOf = (id) => counts[id]?.[SCRIM_KEY] ?? 0;
  // Scrim penalties are tracked separately from the ranked-game ones for the same week.
  const penaltyKey = `scrim:${week}`;
  const alreadyPenalized = new Set(store.getPenalized(guildId, penaltyKey));

  const members = await interaction.guild.members.fetch();
  const lines = [];
  const newlyPenalized = [];
  // Each team role is one team: a team with no scrim at all is penalized differently from a player who skipped.
  for (const roleId of teamRoleIds(guildId)) {
    const team = [...members.filter((m) => !m.user.bot && m.roles.cache.has(roleId)).keys()];
    const teamPlayed = team.some((id) => scrimsOf(id) > 0);
    lines.push(`\n<@&${roleId}>${teamPlayed ? '' : ' — no completed scrim that week'}`);

    for (const id of team.sort((a, b) => scrimsOf(b) - scrimsOf(a))) {
      const penalty = !teamPlayed ? SCRIM.noScrimPenalty : scrimsOf(id) === 0 ? SCRIM.noParticipationPenalty : 0;
      if (!penalizing) {
        const status = alreadyPenalized.has(id) ? '❌ penalized' : penalty ? '⚠️' : '✅';
        lines.push(`${status} <@${id}> — ${scrimsOf(id)}/${SCRIM.cap} scrims`);
      } else if (penalty && !alreadyPenalized.has(id)) {
        alreadyPenalized.add(id);
        newlyPenalized.push(id);
        const balance = store.addPoints(guildId, id, -penalty);
        const reason = teamPlayed ? 'joined no scrim' : 'team completed no scrim';
        lines.push(`<@${id}>: **-${ecs(penalty)}** (${reason}) → ${ecs(balance)}`);
      }
    }
  }

  if (penalizing) {
    if (!newlyPenalized.length) {
      return interaction.editReply(`Nobody to penalize for scrims in the week of ${week}. Everyone played or was already penalized.`);
    }
    store.addPenalized(guildId, penaltyKey, newlyPenalized);
  }

  const embed = new EmbedBuilder()
    .setTitle(`${penalizing ? 'Scrim penalties' : 'Scrims'} — week of ${week}`)
    .setDescription(lines.join('\n').trim().slice(0, 4000))
    .setFooter({
      text: penalizing
        ? `Team with no scrim: -${SCRIM.noScrimPenalty} each · Player who joined none: -${SCRIM.noParticipationPenalty}`
        : '✅ joined a scrim · ⚠️ would be penalized',
    });
  return interaction.editReply({ embeds: [embed] });
}

async function handleWeek(interaction) {
  const guildId = interaction.guildId;
  const penalizing = interaction.options.getSubcommand() === 'penalize';
  const week = weekKey(interaction.options.getString('week') ?? (penalizing ? 'last' : 'this'));

  if (!teamRoleIds(guildId).length) return interaction.reply(ephemeral(NO_TEAMS_HELP));
  if (!canListMembers) return interaction.reply(ephemeral(MEMBERS_INTENT_HELP));

  await interaction.deferReply();
  // Only team categories count toward the weekly practice minimum.
  const teamCategories = Object.fromEntries(
    Object.entries(store.getCategories(guildId)).filter(([, category]) => !category.casual),
  );
  const counts = countGames(store.gamesInWeek(guildId, week).filter((game) => game.category in teamCategories));
  const alreadyPenalized = store.getPenalized(guildId, week);
  const playerIds = await fetchTeamMemberIds(interaction.guild);

  if (penalizing) {
    const targets = playerIds.filter(
      (id) => totalGames(counts[id]) < WEEKLY_MINIMUM && !alreadyPenalized.includes(id),
    );
    if (!targets.length) {
      return interaction.editReply(`Nobody to penalize for the week of ${week}. Everyone met the minimum or was already penalized.`);
    }

    const lines = targets.map((id) => {
      const balance = store.addPoints(guildId, id, -NO_PRACTICE_PENALTY);
      return `<@${id}>: **-${ecs(NO_PRACTICE_PENALTY)}** (${totalGames(counts[id])} games) → ${ecs(balance)}`;
    });
    store.addPenalized(guildId, week, targets);

    const embed = new EmbedBuilder()
      .setTitle(`No-practice penalties — week of ${week}`)
      .setDescription(lines.join('\n').slice(0, 4000))
      .setFooter({ text: `Minimum is ${WEEKLY_MINIMUM} team ranked games per week` });
    return interaction.editReply({ embeds: [embed] });
  }

  if (!playerIds.length) return interaction.editReply(`No team games logged for the week of ${week}.`);

  const lines = playerIds
    .sort((a, b) => totalGames(counts[b]) - totalGames(counts[a]))
    .map((id) => {
      const total = totalGames(counts[id]);
      let status = total >= WEEKLY_MINIMUM ? '✅' : '⚠️';
      if (alreadyPenalized.includes(id)) status = '❌ penalized';
      return `${status} <@${id}> — ${describeCounts(teamCategories, counts[id])} (total ${total})`;
    });

  const embed = new EmbedBuilder()
    .setTitle(`Team ranked games — week of ${week}`)
    .setDescription(lines.join('\n').slice(0, 4000))
    .setFooter({ text: `✅ met the minimum of ${WEEKLY_MINIMUM} games · ⚠️ below minimum` });
  return interaction.editReply({ embeds: [embed] });
}

function describeCategory(category) {
  const who = category.casual ? `casual, ${category.players}+ players` : `team, ${category.players} players`;
  const channel = category.channelId ? `, proof in <#${category.channelId}>` : '';
  return (
    `**${category.label}** (${who}) — win ${ecs(category.win)}, lose ${ecs(category.lose)}, ` +
    `${capOf(category)} paid games/week${channel}`
  );
}

async function handleCategory(interaction) {
  const guildId = interaction.guildId;
  const subcommand = interaction.options.getSubcommand();

  if (subcommand === 'list') {
    const all = Object.values(store.getCategories(guildId));
    const section = (title, lines) => `## ${title}\n${lines.join('\n') || '*(none)*'}`;
    const embed = new EmbedBuilder().setColor(SHOP_ACCENT_COLOR).setDescription(
      [
        section('Casual players — Proof of Alliance (`/casual`)', all.filter((c) => c.casual).map(describeCategory)),
        section('Compe team — Ranked games (`/compe ranked log`)', all.filter((c) => !c.casual).map(describeCategory)),
        section('Compe team — Scrims (`/compe scrim log`)', [
          `**Complete ${SCRIM.lineupSize}-man** — win ${ecs(SCRIM.complete.win)}, lose ${ecs(SCRIM.complete.lose)} each`,
          `**Incomplete line-up** — win ${ecs(SCRIM.incomplete.win)}, lose ${ecs(SCRIM.incomplete.lose)} per present player, sub ${ecs(SCRIM.sub)}`,
          `**Team cancelled** — -${ecs(SCRIM.cancelPresent)} each present member, -${ecs(SCRIM.cancelMissing)} the missing player`,
          `**Weekly** — ${SCRIM.cap} paid scrims per player; no team scrim -${ecs(SCRIM.noScrimPenalty)} each, joined none -${ecs(SCRIM.noParticipationPenalty)}`,
        ]),
      ]
        .join('\n\n')
        .slice(0, 4000),
    );
    return interaction.reply({ embeds: [embed] });
  }

  const name = interaction.options.getString('name', true).trim();
  const key = categoryKey(name);
  if (key === SCRIM_KEY) {
    return interaction.reply(ephemeral('"Scrim" is reserved. Scrims have their own commands under `/compe scrim`.'));
  }
  const existing = store.getCategories(guildId)[key];

  if (subcommand === 'remove') {
    if (!store.removeCategory(guildId, key)) return interaction.reply(ephemeral('There is no category with that name.'));
    return interaction.reply(`🗑️ Removed category **${existing.label}**.`);
  }

  if (!key) return interaction.reply(ephemeral('The category name is empty.'));
  // Options that were left out keep their current value, so editing one thing doesn't reset the rest.
  const category = {
    label: existing?.label ?? name,
    players: interaction.options.getInteger('players', true),
    win: interaction.options.getInteger('win', true),
    lose: interaction.options.getInteger('lose', true),
    cap: interaction.options.getInteger('cap') ?? existing?.cap ?? WEEKLY_CAP,
    casual: interaction.options.getBoolean('casual') ?? existing?.casual ?? false,
    channelId: interaction.options.getChannel('channel')?.id ?? existing?.channelId ?? null,
  };
  store.setCategory(guildId, key, category);
  return interaction.reply(`✅ ${describeCategory(category)}`);
}

async function handlePoints(interaction) {
  const user = interaction.options.getUser('user', true);
  const amount = interaction.options.getInteger('amount', true);
  const removing = interaction.options.getSubcommand() === 'remove';

  const balance = store.addPoints(interaction.guildId, user.id, removing ? -amount : amount);
  const verb = removing ? `Removed **${ecs(amount)}** from` : `Gave **${ecs(amount)}** to`;
  return interaction.reply({ content: `${verb} ${user}. New balance: **${ecs(balance)}**`, allowedMentions: noPings });
}

// A row like "▰▰▱▱▱ 2/5  Duo Rank" showing how much of a weekly cap is used.
const progressRow = (label, done, cap) => `\`${'▰'.repeat(Math.min(done, cap))}${'▱'.repeat(Math.max(cap - done, 0))}\` **${done}/${cap}** ${label}`;

// The balance card. Compe team members get a red card with their team, ranked games and scrims;
// casual players get a silver card with their Proof of Alliance claims.
async function handleBalance(interaction) {
  const guildId = interaction.guildId;
  const user = interaction.options.getUser('user') ?? interaction.user;
  const member = interaction.options.getMember('user') ?? (user.id === interaction.user.id ? interaction.member : null);
  const isCompe = Boolean(member?.roles?.cache && teamRoleIds(guildId).length && isTeamMember(member));

  const week = weekKey('this');
  const played = countGames(store.gamesInWeek(guildId, week))[user.id] ?? {};
  const categories = Object.entries(store.getCategories(guildId));
  const rows = (wanted) =>
    categories.filter(([, c]) => wanted(c)).map(([key, c]) => progressRow(c.label, played[key] ?? 0, capOf(c)));

  const ranking = store.topBalances(guildId, Infinity);
  const position = ranking.findIndex(([id]) => id === user.id);

  const embed = new EmbedBuilder()
    .setColor(isCompe ? THEME.red : THEME.silver)
    .setAuthor({ name: `${interaction.guild.name} • ${isCompe ? 'Compe Team' : 'Casual'}`.slice(0, 256), iconURL: interaction.guild.iconURL() ?? undefined })
    .setTitle(isCompe ? '⚔️ COMPETITIVE PLAYER' : '🎮 CASUAL PLAYER')
    .setDescription(`${user}`)
    .setThumbnail(user.displayAvatarURL())
    .addFields(
      { name: '💰 Balance', value: `**${ecs(store.getBalance(guildId, user.id))}**`, inline: true },
      { name: '🏆 Rank', value: position === -1 ? 'Unranked' : `**#${position + 1}** of ${ranking.length}`, inline: true },
    )
    .setFooter({ text: `Week of ${week} • resets every Monday` })
    .setTimestamp();

  const casualRows = rows((c) => c.casual);
  if (isCompe) {
    const teams = teamRoleIds(guildId).filter((id) => member.roles.cache.has(id));
    embed.addFields({ name: '🛡️ Team', value: teams.map((id) => `<@&${id}>`).join(' '), inline: true });

    const rankedTotal = categories.filter(([, c]) => !c.casual).reduce((sum, [key]) => sum + (played[key] ?? 0), 0);
    const rankedGoal = `${rankedTotal >= WEEKLY_MINIMUM ? '✅' : '⚠️'} ${rankedTotal}/${WEEKLY_MINIMUM} games toward the weekly minimum`;
    embed.addFields({ name: '🎯 Team ranked games this week', value: [...rows((c) => !c.casual), rankedGoal].join('\n') });

    const scrims = played[SCRIM_KEY] ?? 0;
    const scrimGoal = scrims ? '✅ Scrim participation met' : '⚠️ No scrim joined yet this week';
    embed.addFields({ name: '🔥 Scrims this week', value: `${progressRow('Scrims', scrims, SCRIM.cap)}\n${scrimGoal}` });

    // Compe players only see the casual section if they actually claimed casual games.
    if (categories.some(([key, c]) => c.casual && played[key])) {
      embed.addFields({ name: '🎮 Proof of Alliance this week', value: casualRows.join('\n') });
    }
  } else if (casualRows.length) {
    embed.addFields({ name: '🎮 Proof of Alliance claims this week', value: casualRows.join('\n') });
  }

  return interaction.reply({ embeds: [embed] });
}

async function handleLeaderboard(interaction) {
  const top = store.topBalances(interaction.guildId, 10);
  if (!top.length) return interaction.reply('Nobody has any ECs yet.');

  const lines = top.map(([userId, points], i) => `**${i + 1}.** <@${userId}> — ${ecs(points)}`);
  return interaction.reply({ content: `🏆 **Leaderboard**\n${lines.join('\n')}`, allowedMentions: noPings });
}

const timeName = (hour) => ANNOUNCEMENT_TIMES.find((time) => time.value === hour).name;

// Posts the announcements for one time slot. Returns null on success, or the reason nothing was posted.
async function postAnnouncements(guild, hour) {
  const { channelId, slots } = store.getAnnouncements(guild.id);
  const texts = (slots[hour] ?? []).filter(Boolean);
  if (!channelId) return 'No announcement channel is set. Use `/announce channel` first.';
  if (!texts.length) return `No announcements are set for ${timeName(hour)}. Use \`/announce set\`.`;

  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased()) return 'The announcement channel no longer exists. Pick a new one with `/announce channel`.';

  // Only the first message pings @everyone, so people aren't pinged once per announcement.
  const parts = texts.map((text, i) => `${i === 0 ? '@everyone\n' : ''}📢 ${text}`);
  const combined = parts.join('\n\n');
  // Long announcements don't fit in one Discord message together, so they go out one after the other.
  const messages = combined.length <= DISCORD_MESSAGE_LIMIT ? [combined] : parts;
  for (const content of messages) {
    await channel.send({ content, allowedMentions: { parse: ['everyone'] } });
  }
  return null;
}

// Runs every 30 seconds; posts each time slot once per day when its hour arrives.
async function runAnnouncementSchedule() {
  const now = new Date();
  if (now.getMinutes() >= ANNOUNCEMENT_GRACE_MINUTES) return;
  const hour = String(now.getHours());
  if (!ANNOUNCEMENT_TIMES.some((time) => time.value === hour)) return;
  const today = now.toDateString();

  for (const guild of client.guilds.cache.values()) {
    if (store.getAnnouncements(guild.id).lastSent[hour] === today) continue;
    // Mark first, so a slow or failing send can't cause a repeat ping on the next tick.
    store.markAnnouncementSent(guild.id, hour, today);
    try {
      const problem = await postAnnouncements(guild, hour);
      if (problem) console.log(`[${guild.name}] ${timeName(hour)} announcement skipped: ${problem}`);
    } catch (error) {
      console.error(`[${guild.name}] ${timeName(hour)} announcement failed:`, error.message);
    }
  }
}

async function handleAnnounce(interaction) {
  const guildId = interaction.guildId;
  const subcommand = interaction.options.getSubcommand();

  if (subcommand === 'channel') {
    const channel = interaction.options.getChannel('channel', true);
    store.setAnnouncementChannel(guildId, channel.id);
    return interaction.reply(`✅ Daily announcements will be posted in ${channel}.`);
  }

  if (subcommand === 'list') {
    const { channelId, slots } = store.getAnnouncements(guildId);
    const lines = [`**Channel:** ${channelId ? `<#${channelId}>` : 'not set'}`];
    for (const time of ANNOUNCEMENT_TIMES) {
      lines.push(`\n**${time.name}**`);
      for (let i = 0; i < ANNOUNCEMENTS_PER_TIME; i++) lines.push(`${i + 1}. ${slots[time.value]?.[i] ?? '*(empty)*'}`);
    }
    const embed = new EmbedBuilder().setTitle('Daily announcements').setDescription(lines.join('\n').slice(0, 4000));
    return interaction.reply({ embeds: [embed] });
  }

  const hour = interaction.options.getString('time', true);

  if (subcommand === 'test') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const problem = await postAnnouncements(interaction.guild, hour);
    return interaction.editReply(problem ?? `Posted the ${timeName(hour)} announcement.`);
  }

  const number = interaction.options.getInteger('number', true);
  if (subcommand === 'clear') {
    store.setAnnouncementText(guildId, hour, number - 1, null);
    return interaction.reply(`🗑️ Cleared announcement ${number} for ${timeName(hour)}.`);
  }

  // Slash commands can't contain real line breaks, so a typed \n stands in for one.
  const text = interaction.options.getString('message', true).replaceAll('\\n', '\n').trim();
  if (!text) return interaction.reply(ephemeral('The announcement is empty.'));
  store.setAnnouncementText(guildId, hour, number - 1, text);
  return interaction.reply({
    content: `✅ Announcement ${number} for ${timeName(hour)} is now:\n${text}`,
    allowedMentions: noPings,
  });
}

// ---- Shop -----------------------------------------------------------------

// ecs() adds the coin icon for message text; ecsText() is for button labels, which can't show custom emojis.
const ecsText = (amount) => `${amount.toLocaleString('en-US')} ECs`;
const ecs = (amount) => `${ecsText(amount)} ${coin}`;

// The coin icon shown next to prices. Replaced at startup by the custom emoji made from assets/coin.png.
const COIN_EMOJI_NAME = 'ec_coin';
const COIN_IMAGE = path.join(__dirname, 'assets', 'coin.png');
let coin = '🪙';

// Uploads assets/coin.png as one of the bot's own emojis the first time, then reuses it.
// To change the icon: replace the file, delete the emoji in the developer portal (your app -> Emojis), restart.
async function loadCoinEmoji(application) {
  if (!fs.existsSync(COIN_IMAGE)) return;
  try {
    const emojis = await application.emojis.fetch();
    const emoji =
      emojis.find((e) => e.name === COIN_EMOJI_NAME) ??
      (await application.emojis.create({ attachment: COIN_IMAGE, name: COIN_EMOJI_NAME }));
    coin = emoji.toString();
  } catch (error) {
    console.error('Could not load the custom coin emoji, using 🪙 instead:', error.message);
  }
}

const SHOP_ITEMS_PER_PAGE = 5;
// Red and black theme: Discord only lets a bot colour the side strip and pick red or dark grey buttons.
const SHOP_ACCENT_COLOR = 0xe10600;

// Replace this file with your own image (about 1000x400) to change the banner on the shop post.
const SHOP_BANNER = path.join(__dirname, 'assets', 'shop-banner.png');

// Builds the public shop panel: a banner and the button that opens each member's own shop view.
function buildShopMessage(guildId) {
  if (fs.existsSync(SHOP_BANNER)) {
    const embed = new EmbedBuilder().setColor(SHOP_ACCENT_COLOR).setImage('attachment://shop-banner.png');
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('shop:open').setLabel('» Click here to redeem').setStyle(ButtonStyle.Secondary),
    );
    // attachments: [] makes an edit replace the old banner instead of adding a second copy.
    return { embeds: [embed], components: [row], files: [{ attachment: SHOP_BANNER, name: 'shop-banner.png' }], attachments: [] };
  }

  // Without a banner image, fall back to a price list.
  const { items, note } = store.getShop(guildId);
  // A blank line between items keeps the list easy to scan.
  const sections = [Object.values(items).map((item) => `**${item.label}** — ${ecs(item.price)}`).join('\n\n')];
  if (!sections[0]) sections[0] = 'The shop is empty right now.';
  if (note) sections.push(note);

  const embed = new EmbedBuilder()
    .setTitle('🛒 Economy Shop')
    .setColor(SHOP_ACCENT_COLOR)
    .setDescription(sections.join('\n\n').slice(0, 4000))
    .setFooter({ text: 'Click Open Shop to buy. A private ticket opens for your reward.' });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('shop:open').setLabel('Open Shop').setEmoji('🛒').setStyle(ButtonStyle.Danger),
  );
  return { embeds: [embed], components: [row] };
}

// Why an item can't be bought right now, or null if it can (the member's balance is checked separately).
function unavailableReason(item) {
  if (item.stock != null && item.stock <= 0) return 'Sold out';
  return null;
}

// Builds one page of a member's private shop view: each item with its own Buy button, plus page controls.
function buildShopView(guildId, userId, requestedPage) {
  const entries = Object.entries(store.getShop(guildId).items);
  const pageCount = Math.max(1, Math.ceil(entries.length / SHOP_ITEMS_PER_PAGE));
  const page = Math.min(Math.max(requestedPage, 0), pageCount - 1);
  const shown = entries.slice(page * SHOP_ITEMS_PER_PAGE, (page + 1) * SHOP_ITEMS_PER_PAGE);

  const container = new ContainerBuilder()
    .setAccentColor(SHOP_ACCENT_COLOR)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`## Economy Shop\nYour balance: **${ecs(store.getBalance(guildId, userId))}**`),
    )
    .addSeparatorComponents(new SeparatorBuilder());
  if (!shown.length) container.addTextDisplayComponents(new TextDisplayBuilder().setContent('The shop is empty right now.'));

  for (const [key, item] of shown) {
    const lines = [
      `**${item.label}**${item.description ? ` - ${item.description}` : ''}`,
      `**Cost:** ${item.price.toLocaleString('en-US')} ${coin}`,
    ];
    if (item.stock != null) lines.push(`**Stock:** ${item.stock} left`);

    const reason = unavailableReason(item);
    container.addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')))
        .setButtonAccessory(
          new ButtonBuilder()
            .setCustomId(`shop:buy:${key}`)
            .setLabel(reason ?? 'Buy')
            .setStyle(reason ? ButtonStyle.Secondary : ButtonStyle.Danger)
            .setDisabled(Boolean(reason)),
        ),
    );
  }

  // Every button needs a unique id, so the direction is appended even when two point at the same page.
  const pageButton = (emoji, target, direction, disabled) =>
    new ButtonBuilder().setCustomId(`shop:page:${target}:${direction}`).setEmoji(emoji).setStyle(ButtonStyle.Secondary).setDisabled(disabled);
  container.addActionRowComponents(
    new ActionRowBuilder().addComponents(
      pageButton('◀️', page - 1, 'prev', page === 0),
      pageButton('▶️', page + 1, 'next', page === pageCount - 1),
      pageButton('⏮️', 0, 'first', page === 0),
      pageButton('⏭️', pageCount - 1, 'last', page === pageCount - 1),
      new ButtonBuilder().setCustomId('shop:close').setEmoji('🛑').setStyle(ButtonStyle.Danger),
    ),
  );
  if (pageCount > 1) container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# Page ${page + 1} of ${pageCount}`));

  return { components: [container] };
}

// Updates the posted shop message after items or the note change. Does nothing if it was deleted.
async function refreshShopMessage(guild) {
  const posted = store.getShop(guild.id).message;
  // The banner post shows no items or note, so there is nothing on it to update.
  if (!posted || fs.existsSync(SHOP_BANNER)) return;
  try {
    const channel = await guild.channels.fetch(posted.channelId);
    await channel.messages.edit(posted.messageId, buildShopMessage(guild.id));
  } catch {
    // The shop message or its channel is gone; /redeemshop post creates a new one.
  }
}

async function handleShop(interaction) {
  const guildId = interaction.guildId;
  const subcommand = interaction.options.getSubcommand();

  if (subcommand === 'post') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const message = await interaction.channel.send(buildShopMessage(guildId));
    store.updateShop(guildId, { message: { channelId: message.channelId, messageId: message.id } });
    return interaction.editReply('Shop posted. It updates itself when you add or remove items.');
  }

  if (subcommand === 'setup') {
    const changes = {};
    const staffRole = interaction.options.getRole('staff_role');
    const ticketCategory = interaction.options.getChannel('ticket_category');
    const note = interaction.options.getString('note');
    if (staffRole) changes.staffRoleId = staffRole.id;
    if (ticketCategory) changes.ticketCategoryId = ticketCategory.id;
    const archiveCategory = interaction.options.getChannel('archive_category');
    if (archiveCategory) changes.archiveCategoryId = archiveCategory.id;
    if (note !== null) changes.note = note.replaceAll('\\n', '\n').trim();
    store.updateShop(guildId, changes);
    // Not awaited: Discord drops the command if no reply arrives within 3 seconds.
    refreshShopMessage(interaction.guild);

    const shop = store.getShop(guildId);
    return interaction.reply({
      content:
        `**Ticket staff role:** ${shop.staffRoleId ? `<@&${shop.staffRoleId}>` : 'not set (only admins see tickets)'}\n` +
        `**Ticket category:** ${shop.ticketCategoryId ? `<#${shop.ticketCategoryId}>` : 'not set (tickets open at the top of the server)'}\n` +
        `**Archive category:** ${shop.archiveCategoryId ? `<#${shop.archiveCategoryId}>` : 'not set (I create "Redeem Archive" on the first delivery)'}\n` +
        `**Note:**\n${shop.note || '*(none)*'}`,
      allowedMentions: noPings,
    });
  }

  const name = interaction.options.getString('name', true).trim();
  const key = categoryKey(name);

  if (subcommand === 'removeitem') {
    const removed = store.removeShopItem(guildId, key);
    if (!removed) return interaction.reply(ephemeral('There is no shop item with that name.'));
    refreshShopMessage(interaction.guild);
    return interaction.reply(`🗑️ Removed **${removed.label}** from the shop.`);
  }

  const { items } = store.getShop(guildId);
  if (!key) return interaction.reply(ephemeral('The item name is empty.'));
  // Discord allows 25 buttons on one message.
  if (!items[key] && Object.keys(items).length >= 25) {
    return interaction.reply(ephemeral('The shop is full (25 items). Remove one first.'));
  }
  // Options that were left out keep their current value. To make stock unlimited again, remove and re-add the item.
  const item = {
    label: items[key]?.label ?? name,
    price: interaction.options.getInteger('price', true),
    description: interaction.options.getString('description')?.trim() ?? items[key]?.description ?? null,
    stock: interaction.options.getInteger('stock') ?? items[key]?.stock ?? null,
  };
  store.setShopItem(guildId, key, item);
  refreshShopMessage(interaction.guild);
  return interaction.reply(
    `✅ **${item.label}** — ${ecs(item.price)}, stock: ${item.stock ?? 'unlimited'}` +
      (item.description ? `\n${item.description}` : ''),
  );
}

// Confirmation prompts that were already answered, so a double click can't buy twice.
const answeredConfirmations = new Set();

async function handleShopButton(interaction) {
  const guildId = interaction.guildId;
  const [, action, key] = interaction.customId.split(':');

  const userId = interaction.user.id;

  if (action === 'cancel') return interaction.update({ content: 'Cancelled. No ECs were spent.', components: [] });
  if (action === 'open') {
    return interaction.reply({
      ...buildShopView(guildId, userId, 0),
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    });
  }
  // For page buttons the third part of the id is the page number.
  if (action === 'page') return interaction.update(buildShopView(guildId, userId, Number(key)));
  if (action === 'close') {
    await interaction.deferUpdate();
    return interaction.deleteReply();
  }

  const shop = store.getShop(guildId);
  const item = shop.items[key];
  const balance = store.getBalance(guildId, userId);
  const reason = item && unavailableReason(item);

  if (action === 'buy') {
    if (!item) return interaction.reply(ephemeral('That item is no longer in the shop.'));
    if (reason) return interaction.reply(ephemeral(`You can't buy **${item.label}** right now: ${reason.toLowerCase()}.`));
    if (balance < item.price) {
      return interaction.reply(
        ephemeral(`**${item.label}** costs ${ecs(item.price)}. You have ${ecs(balance)}, so you need ${ecs(item.price - balance)} more.`),
      );
    }
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`shop:confirm:${key}`).setLabel(`Redeem for ${ecsText(item.price)}`).setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('shop:cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
    );
    return interaction.reply({
      content: `Redeem **${item.label}** for ${ecs(item.price)}? You have ${ecs(balance)} and will have ${ecs(balance - item.price)} left.`,
      components: [row],
      flags: MessageFlags.Ephemeral,
    });
  }

  // action === 'confirm'
  if (answeredConfirmations.has(interaction.message.id)) return interaction.deferUpdate();
  answeredConfirmations.add(interaction.message.id);

  if (!item) return interaction.update({ content: 'That item is no longer in the shop.', components: [] });
  if (reason) return interaction.update({ content: `**${item.label}** is no longer available: ${reason.toLowerCase()}.`, components: [] });
  if (balance < item.price) {
    return interaction.update({ content: `You no longer have enough ECs for **${item.label}**.`, components: [] });
  }

  // Charge and take stock before the slow channel creation so neither can be used twice; undo both if it fails.
  const newBalance = store.addPoints(guildId, userId, -item.price);
  store.adjustStock(guildId, key, -1);
  await interaction.update({ content: 'Opening your ticket...', components: [] });

  let channel;
  try {
    channel = await openTicket(interaction, shop, item, newBalance);
  } catch (error) {
    console.error('Could not open a redeem ticket:', error.message);
    store.addPoints(guildId, userId, item.price);
    store.adjustStock(guildId, key, 1);
    return interaction.editReply("I couldn't open a ticket, so your ECs were refunded. Please tell staff.");
  }

  store.addRedemption(guildId, channel.id, { userId, itemKey: key, item: item.label, price: item.price, at: Date.now() });
  return interaction.editReply(`✅ Redeemed **${item.label}** for ${ecs(item.price)}. Your ticket: ${channel}`);
}

// Creates a private channel only the buyer, the ticket staff role and admins can see.
async function openTicket(interaction, shop, item, newBalance) {
  const { guild, user } = interaction;
  const access = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.AttachFiles,
    PermissionFlagsBits.ReadMessageHistory,
  ];
  const permissionOverwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: user.id, allow: access },
    { id: client.user.id, allow: access },
  ];
  if (shop.staffRoleId) permissionOverwrites.push({ id: shop.staffRoleId, allow: access });

  const options = { name: `redeem-${user.username}`.slice(0, 90), type: ChannelType.GuildText, permissionOverwrites };
  // A deleted ticket category would make creation fail, so only use it if it still exists.
  if (shop.ticketCategoryId && guild.channels.cache.has(shop.ticketCategoryId)) options.parent = shop.ticketCategoryId;
  const channel = await guild.channels.create(options);

  const embed = new EmbedBuilder()
    .setTitle('🎟️ Redeem ticket')
    .setDescription(
      `**Member:** ${user}\n**Item:** ${item.label}\n**Paid:** ${ecs(item.price)}\n**Balance left:** ${ecs(newBalance)}` +
        (shop.note ? `\n\n${shop.note}` : ''),
    )
    .setFooter({ text: 'Send the details staff need here, e.g. your Wild Rift IGN or GCash number.' });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ticket:delivered').setLabel('Delivered — close ticket').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('ticket:refunded').setLabel('Refund & close').setStyle(ButtonStyle.Danger),
  );
  await channel.send({
    content: `${user}${shop.staffRoleId ? ` <@&${shop.staffRoleId}>` : ''}`,
    embeds: [embed],
    components: [row],
    allowedMentions: { users: [user.id], roles: shop.staffRoleId ? [shop.staffRoleId] : [] },
  });
  return channel;
}

async function handleTicketButton(interaction) {
  const guildId = interaction.guildId;
  const { staffRoleId } = store.getShop(guildId);
  const isStaff =
    interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ||
    (staffRoleId && interaction.member.roles.cache.has(staffRoleId));
  if (!isStaff) return interaction.reply(ephemeral('Only staff can close a redeem ticket.'));

  const status = interaction.customId.split(':')[1];
  const redemption = store.closeRedemption(guildId, interaction.channelId, status);
  if (!redemption) return interaction.reply(ephemeral('This ticket was already closed.'));

  await interaction.update({ components: [] });

  // Delivered tickets are kept in the archive as a record; refunded ones are deleted.
  if (status === 'delivered') {
    const archiveNote = await archiveTicket(interaction.channel, redemption.userId);
    return interaction.followUp({
      content: `✅ **${redemption.item}** marked as delivered by ${interaction.user}.\n${archiveNote}`,
      allowedMentions: noPings,
    });
  }

  const balance = store.addPoints(guildId, redemption.userId, redemption.price);
  store.adjustStock(guildId, redemption.itemKey, 1);
  await interaction.followUp({
    content:
      `↩️ ${interaction.user} refunded ${ecs(redemption.price)} to <@${redemption.userId}> (balance: ${ecs(balance)}).\n` +
      'This ticket will be deleted in 15 seconds.',
    allowedMentions: noPings,
  });
  setTimeout(() => interaction.channel.delete().catch((error) => console.error('Could not delete ticket:', error.message)), 15_000);
}

// Discord allows 50 channels in one category.
const MAX_CHANNELS_PER_CATEGORY = 50;

// Returns the id of the archive category, creating one if none is set, it was deleted, or it is full.
async function getArchiveCategoryId(guild) {
  const shop = store.getShop(guild.id);
  const current = shop.archiveCategoryId && guild.channels.cache.get(shop.archiveCategoryId);
  if (current && current.children.cache.size < MAX_CHANNELS_PER_CATEGORY) return current.id;

  const view = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory];
  const permissionOverwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: client.user.id, allow: view },
  ];
  if (shop.staffRoleId) permissionOverwrites.push({ id: shop.staffRoleId, allow: view });
  const created = await guild.channels.create({ name: 'Redeem Archive', type: ChannelType.GuildCategory, permissionOverwrites });
  store.updateShop(guild.id, { archiveCategoryId: created.id });
  return created.id;
}

// Moves a delivered ticket into the archive and hides it from the buyer. Returns a line describing what happened.
async function archiveTicket(channel, buyerId) {
  try {
    const archiveId = await getArchiveCategoryId(channel.guild);
    // lockPermissions: false keeps the ticket's own permissions, so staff can still read it.
    await channel.setParent(archiveId, { lockPermissions: false });
  } catch (error) {
    console.error('Could not archive ticket:', error.message);
    return `⚠️ I couldn't move this ticket to the archive (${error.message}), so it stays here.`;
  }

  try {
    await channel.permissionOverwrites.delete(buyerId);
  } catch {
    return '📁 Ticket archived. I couldn\'t remove the member\'s access because I need the **Manage Roles** permission.';
  }
  return '📁 Ticket archived. Only staff can see it now.';
}

async function handleAutocomplete(interaction) {
  if (interaction.commandName === 'redeemshop') {
    const typedItem = categoryKey(interaction.options.getFocused());
    const items = Object.entries(store.getShop(interaction.guildId).items)
      .filter(([key]) => key.includes(typedItem))
      .map(([key, item]) => ({ name: item.label, value: key }));
    return interaction.respond(items);
  }

  const typed = categoryKey(interaction.options.getFocused());
  // /casual only offers casual modes and /compe only compe team categories; /category offers everything.
  const wanted = { casual: (category) => category.casual, compe: (category) => !category.casual }[interaction.commandName];
  const choices = Object.entries(store.getCategories(interaction.guildId))
    .filter(([, category]) => !wanted || wanted(category))
    .filter(([key, category]) => key.includes(typed) || categoryKey(category.label).includes(typed))
    .slice(0, 25)
    .map(([key, category]) => ({ name: category.label, value: key }));
  return interaction.respond(choices);
}

// ---- Bot ------------------------------------------------------------------

// Listing everyone with a team role needs the privileged Server Members intent. The bot asks for it, and
// if it isn't switched on in the developer portal it starts without it (see start() below).
let canListMembers = true;
let client = createClient(canListMembers);

function createClient(withMembers) {
  const intents = [GatewayIntentBits.Guilds];
  if (withMembers) intents.push(GatewayIntentBits.GuildMembers);
  const created = new Client({ intents });
  created.once(Events.ClientReady, onReady);
  created.on(Events.InteractionCreate, onInteraction);
  return created;
}

async function onReady(ready) {
  console.log(`Logged in as ${ready.user.tag}`);
  await loadCoinEmoji(ready.application);
  if (GUILD_ID) {
    await ready.application.commands.set(commands, GUILD_ID);
    console.log(`Slash commands registered in server ${GUILD_ID}.`);
  } else {
    await ready.application.commands.set(commands);
    console.log('Slash commands registered globally (may take up to an hour to appear).');
  }
  setInterval(runAnnouncementSchedule, 30_000);
}

const commandHandlers = {
  compe: handleCompe,
  casual: handleClaim,
  casualchannel: (interaction) => handleChannelSetting(interaction, 'casualChannelId', 'Casual claims'),
  casualreview: handleClaimReview,
  redeemshop: handleShop,
  announce: handleAnnounce,
  category: handleCategory,
  points: handlePoints,
  balance: handleBalance,
  leaderboard: handleLeaderboard,
};

// Keyed by the part of a button's custom id before the first colon.
const buttonHandlers = { claim: handleClaimButton, shop: handleShopButton, ticket: handleTicketButton };

async function onInteraction(interaction) {
  if (!interaction.inGuild()) return;

  try {
    if (interaction.isAutocomplete()) await handleAutocomplete(interaction);
    else if (interaction.isChatInputCommand()) await commandHandlers[interaction.commandName]?.(interaction);
    else if (interaction.isButton()) await buttonHandlers[interaction.customId.split(':')[0]]?.(interaction);
  } catch (error) {
    console.error(error);
    if (!interaction.isRepliable()) return;
    const reply = ephemeral('Something went wrong. Please try again.');
    if (interaction.replied || interaction.deferred) await interaction.followUp(reply).catch(() => {});
    else await interaction.reply(reply).catch(() => {});
  }
}

async function start() {
  try {
    await client.login(TOKEN);
  } catch (error) {
    await client.destroy();
    const intentRefused = error.code === 'DisallowedIntents' || /disallowed intents/i.test(error.message);
    if (intentRefused && canListMembers) {
      console.warn(
        'Server Members Intent is off, so /compe status and penalize are disabled. ' +
          'Turn it on at https://discord.com/developers/applications -> your app -> Bot, then restart.',
      );
      canListMembers = false;
      client = createClient(canListMembers);
      return start();
    }
    if (error.code === 'TokenInvalid') console.error('Discord rejected the token. Check DISCORD_TOKEN in your .env file.');
    else console.error(error);
    process.exitCode = 1;
  }
}

start();
