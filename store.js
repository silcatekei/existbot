const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'economy.json');

// Categories every server starts with. Staff can change them with /category set.
// Team categories are logged by staff with /game log and need an exact player count.
const TEAM_CATEGORIES = {
  duo: { label: 'Duo Rank', players: 2, win: 200, lose: 20, cap: 3 },
  trio: { label: 'Trio', players: 3, win: 300, lose: 30, cap: 3 },
  '5man': { label: '5 Man', players: 5, win: 500, lose: 100, cap: 3 },
};
// Casual ("Proof of Alliance") categories are claimed by players with /claim and need 2+ guildmates.
const CASUAL_CATEGORIES = {
  adventure: { label: 'Adventure Mode', casual: true, players: 2, win: 50, lose: 50, cap: 10 },
  pvp: { label: 'PVP', casual: true, players: 2, win: 50, lose: 50, cap: 5 },
  ranked: { label: 'Ranked', casual: true, players: 2, win: 100, lose: 50, cap: 10 },
};

// Shop items every server starts with. Staff can change them with /redeemshop additem and /redeemshop removeitem.
const DEFAULT_SHOP_ITEMS = {
  epicskin: { label: 'Epic Skin', group: 'Skins', price: 48750 },
  legendaryskin: { label: 'Legendary Skin', group: 'Skins', price: 65250 },
  normalwildpass: { label: 'Normal Wild Pass', group: 'Wild Pass', price: 21000 },
  elitewildpass: { label: 'Elite Wild Pass', group: 'Wild Pass', price: 48750 },
  '50hexkeys': { label: '50 HexKeys', group: 'Hextech Keys', price: 37500 },
  php50gcash: { label: 'PHP 50 GCash', group: 'GCash', price: 12000 },
  php100gcash: { label: 'PHP 100 GCash', group: 'GCash', price: 20000 },
};
const DEFAULT_SHOP_NOTE =
  'Please add the following WR accounts:\nRIFT#0009\nRIFT#00070\nRIFT#0006\nRIFT#0003\nRIFT#00020\nRIFT#00010';

// Shape: { [guildId]: {
//   balances: { [userId]: number },
//   categories: { [key]: { label, players, win, lose, cap, casual, channelId } },
//   games: [{ week, category, result, players: [userId], paid: { [userId]: number }, loggedBy, loggedAt }],
//   claims: { [messageId]: { week, category, result, players: [userId], claimant } },  // awaiting staff review
//   penalized: { [week]: [userId] },
// } }
let db = {};
if (fs.existsSync(DATA_FILE)) {
  db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // Write to a temp file first so a crash mid-write can't corrupt the real one.
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

function guild(guildId) {
  const g = (db[guildId] ??= {});
  g.balances ??= {};
  g.categories ??= structuredClone(TEAM_CATEGORIES);
  // Servers saved before casual categories existed get them added once.
  if (!g.casualSeeded) {
    for (const [key, category] of Object.entries(CASUAL_CATEGORIES)) g.categories[key] ??= { ...category };
    g.casualSeeded = true;
  }
  g.games ??= [];
  g.claims ??= {};
  g.penalized ??= {};
  // slots: { [hour]: [text, text] }, lastSent: { [hour]: 'YYYY-MM-DD' }
  g.announcements ??= { channelId: null, slots: {}, lastSent: {} };
  // message: where the shop was posted, so it can be refreshed when items change.
  g.shop ??= {
    items: structuredClone(DEFAULT_SHOP_ITEMS),
    note: DEFAULT_SHOP_NOTE,
    staffRoleId: null,
    ticketCategoryId: null,
    message: null,
  };
  // Shop items: { label, price, description, stock }; stock is null when unlimited.
  // { [ticketChannelId]: { userId, itemKey, item, price, status: 'open' | 'delivered' | 'refunded', at } }
  g.redemptions ??= {};
  return g;
}

// Server-wide options, e.g. { reviewChannelId } for where staff approve claims.
function getSettings(guildId) {
  return (guild(guildId).settings ??= {});
}

function updateSettings(guildId, changes) {
  Object.assign(getSettings(guildId), changes);
  save();
}

function getShop(guildId) {
  return guild(guildId).shop;
}

function updateShop(guildId, changes) {
  Object.assign(guild(guildId).shop, changes);
  save();
}

function setShopItem(guildId, key, item) {
  guild(guildId).shop.items[key] = item;
  save();
}

// Returns the removed item, or undefined if it didn't exist.
function removeShopItem(guildId, key) {
  const items = guild(guildId).shop.items;
  const item = items[key];
  if (item) {
    delete items[key];
    save();
  }
  return item;
}

// Adds to (or takes from) an item's stock. Items with unlimited stock (null) are left alone.
function adjustStock(guildId, key, change) {
  const item = guild(guildId).shop.items[key];
  if (item?.stock == null) return;
  item.stock = Math.max(0, item.stock + change);
  save();
}

function addRedemption(guildId, channelId, redemption) {
  guild(guildId).redemptions[channelId] = { ...redemption, status: 'open' };
  save();
}

// Marks an open redemption as delivered or refunded and returns it; undefined if it isn't open.
function closeRedemption(guildId, channelId, status) {
  const redemption = guild(guildId).redemptions[channelId];
  if (redemption?.status !== 'open') return undefined;
  redemption.status = status;
  save();
  return redemption;
}

function getAnnouncements(guildId) {
  return guild(guildId).announcements;
}

function setAnnouncementChannel(guildId, channelId) {
  guild(guildId).announcements.channelId = channelId;
  save();
}

// index is 0 or 1; pass null as text to clear that announcement.
function setAnnouncementText(guildId, hour, index, text) {
  const slots = guild(guildId).announcements.slots;
  slots[hour] ??= [null, null];
  slots[hour][index] = text;
  save();
}

function markAnnouncementSent(guildId, hour, date) {
  guild(guildId).announcements.lastSent[hour] = date;
  save();
}

function addClaim(guildId, messageId, claim) {
  guild(guildId).claims[messageId] = claim;
  save();
}

// Removes and returns a pending claim, or undefined if it was already reviewed.
function takeClaim(guildId, messageId) {
  const claims = guild(guildId).claims;
  const claim = claims[messageId];
  if (claim) {
    delete claims[messageId];
    save();
  }
  return claim;
}

function getBalance(guildId, userId) {
  return guild(guildId).balances[userId] ?? 0;
}

// Adds (or subtracts) ECs. Balances may go negative. Returns the new balance.
function addPoints(guildId, userId, amount) {
  const balances = guild(guildId).balances;
  balances[userId] = (balances[userId] ?? 0) + amount;
  save();
  return balances[userId];
}

function topBalances(guildId, limit) {
  return Object.entries(guild(guildId).balances)
    .filter(([, points]) => points !== 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);
}

function getCategories(guildId) {
  return guild(guildId).categories;
}

function setCategory(guildId, key, category) {
  guild(guildId).categories[key] = category;
  save();
}

// Returns false if the category didn't exist.
function removeCategory(guildId, key) {
  const categories = guild(guildId).categories;
  if (!(key in categories)) return false;
  delete categories[key];
  save();
  return true;
}

function gamesInWeek(guildId, week) {
  return guild(guildId).games.filter((game) => game.week === week);
}

function addGame(guildId, game) {
  guild(guildId).games.push(game);
  save();
}

// Removes and returns the most recently logged game, or undefined if there is none.
function popLastGame(guildId) {
  const game = guild(guildId).games.pop();
  if (game) save();
  return game;
}

function getPenalized(guildId, week) {
  return guild(guildId).penalized[week] ?? [];
}

function addPenalized(guildId, week, userIds) {
  const penalized = guild(guildId).penalized;
  penalized[week] = [...(penalized[week] ?? []), ...userIds];
  save();
}

module.exports = {
  getBalance,
  addPoints,
  topBalances,
  getCategories,
  setCategory,
  removeCategory,
  gamesInWeek,
  addGame,
  popLastGame,
  getPenalized,
  addPenalized,
  addClaim,
  takeClaim,
  getAnnouncements,
  setAnnouncementChannel,
  setAnnouncementText,
  markAnnouncementSent,
  getSettings,
  updateSettings,
  getShop,
  updateShop,
  setShopItem,
  removeShopItem,
  adjustStock,
  addRedemption,
  closeRedemption,
};
