const {
  Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, PermissionFlagsBits
} = require('discord.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ]
});

// ── CONFIG ───────────────────────────────────────────────────────────────────
const CONFIG = {
  BET_TIERS: [
    { name: 'elite', min: 10000, max: Infinity },
    { name: 'big',   min: 5000,  max: 9999     },
    { name: 'small', min: 2000,  max: 4999     },
    { name: 'tiny',  min: 500,   max: 1999     },
  ],
  TICKETS_CATEGORY_NAME: 'Tickets',
  TICKET_LOG_CHANNEL:    'ticket-log',   // channel where closed tickets are logged
  MIDDLEMAN_ROLE_NAME:   'Middleman',
  MOD_ROLE_NAME:         'Moderator',
  HOUSE_CUT_PERCENT:     10,
  STRIKES_BEFORE_BAN:    3,
  STRIKE_ROLE_PREFIX:    'strike',   // roles: strike-1, strike-2, strike-3
  BET_BAN_ROLE_NAME:     'Bet Banned',
};
// ─────────────────────────────────────────────────────────────────────────────

// challengeId -> { challengerId, game, amount, channelId, embedMessageId }
const activeChallenges = new Map();
// ticketChannelId -> { challengerId, opponentId, game, amount }
const activeTickets = new Map();

client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  await registerCommands();
});

// ── REGISTER COMMANDS ────────────────────────────────────────────────────────
async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName('challenge')
      .setDescription('Post a 1v1 betting challenge in this channel')
      .addStringOption(o => o.setName('game').setDescription('Roblox game name').setRequired(true))
      .addIntegerOption(o => o.setName('amount').setDescription('Your bet in Rocoins (min 500)').setRequired(true).setMinValue(500)),

    new SlashCommandBuilder()
      .setName('cancel')
      .setDescription('Cancel your open challenge'),

    new SlashCommandBuilder()
      .setName('result')
      .setDescription('Submit match result (use inside ticket)')
      .addUserOption(o => o.setName('winner').setDescription('Who won?').setRequired(true))
      .addStringOption(o => o.setName('proof').setDescription('Screenshot/video link').setRequired(true)),

    new SlashCommandBuilder()
      .setName('strike')
      .setDescription('[Mod] Give a strike to a user')
      .addUserOption(o => o.setName('user').setDescription('User to strike').setRequired(true))
      .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(true)),

    new SlashCommandBuilder()
      .setName('closeticket')
      .setDescription('[Mod/Middleman] Close this ticket'),

    new SlashCommandBuilder()
      .setName('payout')
      .setDescription('Calculate payout after house cut')
      .addIntegerOption(o => o.setName('amount').setDescription('Each player bet amount').setRequired(true)),
  ];

  await client.application.commands.set(commands);
  console.log('✅ Commands registered');
}

// ── ROUTER ───────────────────────────────────────────────────────────────────
client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'challenge')   return await handleChallenge(interaction);
      if (interaction.commandName === 'cancel')      return await handleCancel(interaction);
      if (interaction.commandName === 'result')      return await handleResult(interaction);
      if (interaction.commandName === 'strike')      return await handleStrike(interaction);
      if (interaction.commandName === 'closeticket') return await handleCloseTicket(interaction);
      if (interaction.commandName === 'payout')      return await handlePayout(interaction);
    }
    if (interaction.isButton()) {
      if (interaction.customId.startsWith('join_'))  return await handleJoin(interaction);
      if (interaction.customId.startsWith('leave_')) return await handleLeave(interaction);
    }
  } catch (err) {
    console.error(err);
    const payload = { content: '❌ Something went wrong.', ephemeral: true };
    interaction.replied || interaction.deferred
      ? interaction.followUp(payload)
      : interaction.reply(payload);
  }
});

// ── /challenge ────────────────────────────────────────────────────────────────
async function handleChallenge(interaction) {
  const game   = interaction.options.getString('game');
  const amount = interaction.options.getInteger('amount');

  // Must be used in a tier channel
  const tier = CONFIG.BET_TIERS.find(t => interaction.channel.name.toLowerCase().includes(t.name));
  if (!tier) {
    const names = CONFIG.BET_TIERS.map(t => `#${t.name}`).join(', ');
    return interaction.reply({ content: `❌ Use /challenge inside one of the bet channels: ${names}`, ephemeral: true });
  }

  // Enforce correct amount for this tier
  if (amount < tier.min || amount > tier.max) {
    const max = tier.max === Infinity ? '∞' : tier.max.toLocaleString();
    return interaction.reply({
      content: `❌ In #${tier.name} the bet must be between **${tier.min.toLocaleString()}** and **${max}** Rocoins.`,
      ephemeral: true
    });
  }

  // Check user doesn't already have an open challenge
  const existing = [...activeChallenges.values()].find(c => c.challengerId === interaction.user.id);
  if (existing) {
    return interaction.reply({ content: '❌ You already have an open challenge. Use /cancel first.', ephemeral: true });
  }

  const winnerPayout = Math.floor(amount * 2 * (1 - CONFIG.HOUSE_CUT_PERCENT / 100));
  const houseCut     = amount * 2 - winnerPayout;

  const embed = new EmbedBuilder()
    .setColor(0x00b4d8)
    .setTitle('🎮 1v1 Challenge')
    .setDescription(`<@${interaction.user.id}> is looking for a match!`)
    .addFields(
      { name: '🎮 Game',        value: game,                        inline: true },
      { name: '🪙 Bet',         value: `${amount.toLocaleString()} Rocoins each`, inline: true },
      { name: '💰 Winner Gets', value: `${winnerPayout.toLocaleString()} Rocoins`, inline: true },
      { name: '🏦 House Cut',   value: `${houseCut.toLocaleString()} Rocoins (${CONFIG.HOUSE_CUT_PERCENT}%)`, inline: true },
    )
    .setFooter({ text: 'Clicking Leave after joining = automatic strike.' })
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`join_${interaction.user.id}`)
      .setLabel('✅ Join')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`leave_${interaction.user.id}`)
      .setLabel('❌ Leave')
      .setStyle(ButtonStyle.Danger),
  );

  // Delete the slash command invocation (reply ephemerally first to satisfy Discord, then send embed)
  await interaction.reply({ content: '📨 Posting your challenge...', ephemeral: true });
  const embedMsg = await interaction.channel.send({ embeds: [embed], components: [row] });

  // Create ticket immediately for the challenger
  const ticket = await createTicket(interaction.guild, interaction.member, null, { game, amount, challengerId: interaction.user.id, embedMessageId: embedMsg.id, channelId: interaction.channel.id });

  activeChallenges.set(embedMsg.id, {
    challengerId:   interaction.user.id,
    game,
    amount,
    channelId:      interaction.channel.id,
    embedMessageId: embedMsg.id,
    ticketChannelId: ticket.id,
  });

  await interaction.editReply({ content: `✅ Challenge posted! Your ticket: ${ticket}` });
}

// ── Join button ───────────────────────────────────────────────────────────────
async function handleJoin(interaction) {
  const challengerId = interaction.customId.split('_')[1];

  if (interaction.user.id === challengerId) {
    return interaction.reply({ content: "❌ You can't join your own challenge.", ephemeral: true });
  }

  const challenge = [...activeChallenges.values()].find(c => c.challengerId === challengerId && c.embedMessageId === interaction.message.id);
  if (!challenge) {
    return interaction.reply({ content: '❌ This challenge is no longer active.', ephemeral: true });
  }

  // Check opponent isn't bet banned
  const banRole = interaction.guild.roles.cache.find(r => r.name === CONFIG.BET_BAN_ROLE_NAME);
  if (banRole && interaction.member.roles.cache.has(banRole.id)) {
    return interaction.reply({ content: '🚫 You are bet banned and cannot join challenges.', ephemeral: true });
  }

  // Remove from active challenges so no one else can join
  activeChallenges.delete(interaction.message.id);

  // Disable both buttons on the embed
  const disabledRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('joined').setLabel('✅ Match Found').setStyle(ButtonStyle.Success).setDisabled(true),
    new ButtonBuilder().setCustomId('gone').setLabel('❌ Leave').setStyle(ButtonStyle.Danger).setDisabled(true),
  );
  await interaction.message.edit({ components: [disabledRow] });

  // Add opponent to existing ticket and update it
  const ticketChannel = interaction.guild.channels.cache.get(challenge.ticketChannelId);
  if (ticketChannel) {
    await ticketChannel.permissionOverwrites.edit(interaction.user.id, {
      [PermissionFlagsBits.ViewChannel]: true,
      [PermissionFlagsBits.SendMessages]: true,
    });

    const winnerPayout = Math.floor(challenge.amount * 2 * (1 - CONFIG.HOUSE_CUT_PERCENT / 100));
    const houseCut     = challenge.amount * 2 - winnerPayout;
    const middlemanRole = interaction.guild.roles.cache.find(r => r.name === CONFIG.MIDDLEMAN_ROLE_NAME);

    const ticketEmbed = new EmbedBuilder()
      .setColor(0x2ecc71)
      .setTitle('🎫 Match Ready!')
      .setDescription(
        `**Both players are here — let's go!**\n\n` +
        `**Steps:**\n` +
        `1️⃣ Both players tip **${challenge.amount.toLocaleString()} Rocoins** to the middleman\n` +
        `2️⃣ Middleman confirms receipt\n` +
        `3️⃣ Play the match\n` +
        `4️⃣ Post screenshot/video proof here\n` +
        `5️⃣ Use \`/result @winner <proof link>\`\n` +
        `6️⃣ Middleman pays out winner`
      )
      .addFields(
        { name: '👤 Challenger', value: `<@${challenge.challengerId}>`, inline: true },
        { name: '👤 Opponent',   value: `${interaction.user}`,          inline: true },
        { name: '\u200B',        value: '\u200B',                       inline: true },
        { name: '🎮 Game',       value: challenge.game,                 inline: true },
        { name: '🪙 Bet Each',   value: `${challenge.amount.toLocaleString()} Rocoins`, inline: true },
        { name: '💰 Winner Gets', value: `${winnerPayout.toLocaleString()} Rocoins`,   inline: true },
        { name: '🏦 House Cut',  value: `${houseCut.toLocaleString()} Rocoins`,        inline: true },
      )
      .setFooter({ text: 'Backing out now = automatic strike.' })
      .setTimestamp();

    await ticketChannel.send({
      content: `<@${challenge.challengerId}> ${interaction.user} ${middlemanRole ?? ''}`,
      embeds: [ticketEmbed],
    });

    activeTickets.set(ticketChannel.id, {
      challengerId: challenge.challengerId,
      opponentId:   interaction.user.id,
      game:         challenge.game,
      amount:       challenge.amount,
    });
  }

  await interaction.reply({ content: `✅ You've joined! Head to ${ticketChannel}`, ephemeral: true });
}

// ── Leave button ──────────────────────────────────────────────────────────────
async function handleLeave(interaction) {
  const challengerId = interaction.customId.split('_')[1];
  const challenge    = [...activeChallenges.values()].find(c => c.embedMessageId === interaction.message.id);

  // ── Challenger clicks Leave (before anyone joined) → confirm cancel ──
  if (interaction.user.id === challengerId) {
    const confirmRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`confirm_cancel_${interaction.message.id}`)
        .setLabel('Yes, cancel my challenge')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`abort_cancel_${interaction.message.id}`)
        .setLabel('No, keep it open')
        .setStyle(ButtonStyle.Secondary),
    );
    return interaction.reply({
      content: '⚠️ Are you sure you want to cancel your challenge? Your ticket will be deleted.',
      components: [confirmRow],
      ephemeral: true,
    });
  }

  // ── Someone else clicks Leave (match is live) → confirm leave + strike warning ──
  const ticketChannelId = challenge?.ticketChannelId;
  const ticket = activeTickets.get(ticketChannelId);

  if (!ticket) {
    return interaction.reply({ content: "❌ There's no active match to leave.", ephemeral: true });
  }

  if (![ticket.challengerId, ticket.opponentId].includes(interaction.user.id)) {
    return interaction.reply({ content: "❌ You're not in this match.", ephemeral: true });
  }

  const confirmRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`confirm_leave_${interaction.message.id}`)
      .setLabel('Yes, leave (I accept the strike)')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`abort_leave_${interaction.message.id}`)
      .setLabel('No, stay in the match')
      .setStyle(ButtonStyle.Secondary),
  );
  return interaction.reply({
    content: '⚠️ **Are you sure you want to leave?**\nLeaving an active match will give you **strike 1**. You will be removed from the ticket.',
    components: [confirmRow],
    ephemeral: true,
  });
}

// ── Confirm / abort cancel (challenger) ──────────────────────────────────────
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;

  // Confirm cancel
  if (interaction.customId.startsWith('confirm_cancel_')) {
    const embedMsgId = interaction.customId.replace('confirm_cancel_', '');
    const challenge  = [...activeChallenges.values()].find(c => c.embedMessageId === embedMsgId);

    if (challenge) {
      activeChallenges.delete(embedMsgId);

      // Give strike to the challenger who cancelled
      const strikeCount = await giveStrike(interaction.guild, interaction.member, 'Cancelled their own challenge');

      // Log ticket and lock it instead of deleting
      if (challenge.ticketChannelId) {
        const tc = interaction.guild.channels.cache.get(challenge.ticketChannelId);
        if (tc) {
          await logAndLockTicket(interaction.guild, tc, `🚫 Challenge cancelled by <@${interaction.user.id}>. They received **Strike ${strikeCount}/${CONFIG.STRIKES_BEFORE_BAN}**.`);
        }
      }

      // Disable embed buttons
      try {
        const ch  = interaction.guild.channels.cache.get(challenge.channelId);
        const msg = await ch?.messages.fetch(embedMsgId);
        if (msg) {
          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('x1').setLabel('❌ Cancelled').setStyle(ButtonStyle.Danger).setDisabled(true),
            new ButtonBuilder().setCustomId('x2').setLabel('❌ Leave').setStyle(ButtonStyle.Danger).setDisabled(true),
          );
          await msg.edit({ components: [row] });
        }
      } catch {}
    }

    return interaction.update({ content: `✅ Your challenge has been cancelled. You have received **Strike ${await getCurrentStrikes(interaction.guild, interaction.member)}/${CONFIG.STRIKES_BEFORE_BAN}**.`, components: [] });
  }

  // Abort cancel
  if (interaction.customId.startsWith('abort_cancel_')) {
    return interaction.update({ content: '✅ Cancelled — your challenge is still open.', components: [] });
  }

  // Confirm leave (opponent)
  if (interaction.customId.startsWith('confirm_leave_')) {
    const embedMsgId     = interaction.customId.replace('confirm_leave_', '');
    const challenge      = [...activeChallenges.values()].find(c => c.embedMessageId === embedMsgId);
    const ticketChannelId = challenge?.ticketChannelId;
    const ticket          = activeTickets.get(ticketChannelId);

    if (!ticket) return interaction.update({ content: '❌ Match no longer active.', components: [] });

    // Give strike
    const strikeCount = await giveStrike(interaction.guild, interaction.member, 'Left an active match');

    // Kick from ticket (remove view permission)
    if (ticketChannelId) {
      const tc = interaction.guild.channels.cache.get(ticketChannelId);
      if (tc) {
        await tc.permissionOverwrites.edit(interaction.user.id, {
          [PermissionFlagsBits.ViewChannel]: false,
          [PermissionFlagsBits.SendMessages]: false,
        }).catch(() => {});
        await tc.send(
          `⚠️ <@${interaction.user.id}> has left the match and been removed from this ticket.\n` +
          `They have been given **Strike ${strikeCount}/${CONFIG.STRIKES_BEFORE_BAN}**.`
        ).catch(() => {});
      }
    }

    return interaction.update({
      content: `✅ You have left the match and received **Strike ${strikeCount}/${CONFIG.STRIKES_BEFORE_BAN}**. You have been removed from the ticket.`,
      components: [],
    });
  }

  // Abort leave
  if (interaction.customId.startsWith('abort_leave_')) {
    return interaction.update({ content: "✅ Good call — you're still in the match.", components: [] });
  }
});

// ── Create ticket channel ─────────────────────────────────────────────────────
async function createTicket(guild, challenger, opponent, challenge) {
  const category      = guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && c.name === CONFIG.TICKETS_CATEGORY_NAME);
  const middlemanRole = guild.roles.cache.find(r => r.name === CONFIG.MIDDLEMAN_ROLE_NAME);

  const overwrites = [
    { id: guild.roles.everyone, deny: [PermissionFlagsBits.ViewChannel] },
    { id: challenger.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
    ...(middlemanRole ? [{ id: middlemanRole.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages] }] : []),
  ];

  if (opponent) {
    overwrites.push({ id: opponent.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] });
  }

  const channel = await guild.channels.create({
    name: `bet-${challenger.user.username}`,
    type: ChannelType.GuildText,
    parent: category?.id,
    permissionOverwrites: overwrites,
  });

  // Send waiting message
  const waitEmbed = new EmbedBuilder()
    .setColor(0xf39c12)
    .setTitle('⏳ Waiting for opponent...')
    .setDescription(
      `Your challenge has been posted in <#${challenge.channelId}>.\n\n` +
      `**Game:** ${challenge.game}\n` +
      `**Bet:** ${challenge.amount.toLocaleString()} Rocoins each\n\n` +
      `As soon as someone joins, the match details will appear here.\n` +
      `Use \`/cancel\` if you change your mind.`
    )
    .setTimestamp();

  await channel.send({ content: `${challenger}`, embeds: [waitEmbed] });

  return channel;
}

// ── Give strike (shared helper) ───────────────────────────────────────────────
async function giveStrike(guild, member, reason) {
  let currentStrikes = 0;
  for (let i = 1; i <= CONFIG.STRIKES_BEFORE_BAN; i++) {
    const r = guild.roles.cache.find(role => role.name === `${CONFIG.STRIKE_ROLE_PREFIX}-${i}`);
    if (r && member.roles.cache.has(r.id)) currentStrikes = i;
  }

  const newStrikes = Math.min(currentStrikes + 1, CONFIG.STRIKES_BEFORE_BAN);
  const newRole    = guild.roles.cache.find(r => r.name === `${CONFIG.STRIKE_ROLE_PREFIX}-${newStrikes}`);
  if (newRole) await member.roles.add(newRole).catch(() => {});

  if (newStrikes >= CONFIG.STRIKES_BEFORE_BAN) {
    const banRole = guild.roles.cache.find(r => r.name === CONFIG.BET_BAN_ROLE_NAME);
    if (banRole) await member.roles.add(banRole).catch(() => {});
  }

  return newStrikes;
}

// ── /cancel ───────────────────────────────────────────────────────────────────
async function handleCancel(interaction) {
  const entry = [...activeChallenges.entries()].find(([, v]) => v.challengerId === interaction.user.id);
  if (!entry) return interaction.reply({ content: "❌ You don't have an open challenge.", ephemeral: true });

  // Confirm before cancelling
  const confirmRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`confirm_cancel_${entry[0]}`)
      .setLabel('Yes, cancel my challenge')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`abort_cancel_${entry[0]}`)
      .setLabel('No, keep it open')
      .setStyle(ButtonStyle.Secondary),
  );
  return interaction.reply({
    content: '⚠️ Are you sure you want to cancel your challenge? **You will receive a strike.**',
    components: [confirmRow],
    ephemeral: true,
  });
}

// ── /result ───────────────────────────────────────────────────────────────────
async function handleResult(interaction) {
  const ticket = activeTickets.get(interaction.channel.id);
  if (!ticket) return interaction.reply({ content: '❌ Use this inside a bet ticket.', ephemeral: true });

  const winner = interaction.options.getUser('winner');
  const proof  = interaction.options.getString('proof');

  if (![ticket.challengerId, ticket.opponentId].includes(winner.id)) {
    return interaction.reply({ content: '❌ Winner must be one of the two players in this ticket.', ephemeral: true });
  }

  const winnerPayout = Math.floor(ticket.amount * 2 * (1 - CONFIG.HOUSE_CUT_PERCENT / 100));

  const embed = new EmbedBuilder()
    .setColor(0x2ecc71)
    .setTitle('🏆 Result Submitted')
    .addFields(
      { name: '🥇 Winner',      value: `<@${winner.id}>`,              inline: true },
      { name: '💰 Payout',      value: `${winnerPayout.toLocaleString()} Rocoins`, inline: true },
      { name: '🔗 Proof',       value: proof,                          inline: false },
    )
    .setDescription('Middleman: verify the proof and pay out the winner, then use `/closeticket`.')
    .setTimestamp();

  await interaction.reply({ embeds: [embed] });
}

// ── /strike ───────────────────────────────────────────────────────────────────
async function handleStrike(interaction) {
  const isMod       = interaction.member.roles.cache.some(r => r.name === CONFIG.MOD_ROLE_NAME);
  const isMiddleman = interaction.member.roles.cache.some(r => r.name === CONFIG.MIDDLEMAN_ROLE_NAME);
  if (!isMod && !isMiddleman) return interaction.reply({ content: '❌ No permission.', ephemeral: true });

  const target = interaction.options.getMember('user');
  const reason = interaction.options.getString('reason');
  const count  = await giveStrike(interaction.guild, target, reason);

  const embed = new EmbedBuilder()
    .setColor(count >= CONFIG.STRIKES_BEFORE_BAN ? 0xe74c3c : 0xf39c12)
    .setTitle(`⚠️ Strike ${count}/${CONFIG.STRIKES_BEFORE_BAN}`)
    .addFields(
      { name: 'User',      value: `${target}`,              inline: true },
      { name: 'Reason',    value: reason,                   inline: true },
      { name: 'Issued By', value: `${interaction.user}`,   inline: true },
    )
    .setDescription(count >= CONFIG.STRIKES_BEFORE_BAN ? '🚫 User has been **Bet Banned**.' : '')
    .setTimestamp();

  await interaction.reply({ embeds: [embed] });
}

// ── /closeticket ──────────────────────────────────────────────────────────────
async function handleCloseTicket(interaction) {
  const isMod = interaction.member.roles.cache.some(r => r.name === CONFIG.MOD_ROLE_NAME);
  if (!isMod) return interaction.reply({ content: '❌ Only Moderators can close tickets.', ephemeral: true });

  activeTickets.delete(interaction.channel.id);
  await interaction.reply({ content: '🔒 Closing and logging this ticket...' });
  await logAndLockTicket(interaction.guild, interaction.channel, `🔒 Ticket closed by <@${interaction.user.id}>.`);
}

// ── Log and lock ticket ───────────────────────────────────────────────────────
async function logAndLockTicket(guild, ticketChannel, reason) {
  const logChannel = guild.channels.cache.find(c => c.name === CONFIG.TICKET_LOG_CHANNEL);

  // Collect last 50 messages as a transcript summary
  let transcript = '';
  try {
    const messages = await ticketChannel.messages.fetch({ limit: 50 });
    const sorted   = [...messages.values()].reverse();
    transcript = sorted
      .filter(m => !m.author.bot || m.embeds.length > 0)
      .map(m => {
        const time    = new Date(m.createdTimestamp).toUTCString();
        const content = m.content || (m.embeds[0]?.title ?? '');
        return `[${time}] ${m.author.username}: ${content}`;
      })
      .join('\n')
      .slice(0, 3900); // stay under embed limit
  } catch {}

  if (logChannel) {
    const logEmbed = new EmbedBuilder()
      .setColor(0x95a5a6)
      .setTitle(`📁 Ticket Closed — #${ticketChannel.name}`)
      .setDescription(reason)
      .addFields({ name: '📜 Transcript (last 50 messages)', value: transcript ? "```" + transcript + "```" : "No messages recorded." })
      .setTimestamp();

    await logChannel.send({ embeds: [logEmbed] }).catch(() => {});
  }

  // Lock channel — remove send permissions for everyone, keep it visible to mods
  await ticketChannel.permissionOverwrites.edit(guild.roles.everyone, {
    [PermissionFlagsBits.ViewChannel]:  false,
    [PermissionFlagsBits.SendMessages]: false,
  }).catch(() => {});

  // Delete after logging
  setTimeout(() => ticketChannel.delete().catch(() => {}), 3000);
}

// ── Get current strike count helper ──────────────────────────────────────────
async function getCurrentStrikes(guild, member) {
  let count = 0;
  for (let i = 1; i <= CONFIG.STRIKES_BEFORE_BAN; i++) {
    const r = guild.roles.cache.find(role => role.name === `${CONFIG.STRIKE_ROLE_PREFIX}-${i}`);
    if (r && member.roles.cache.has(r.id)) count = i;
  }
  return count;
}

// ── /payout ───────────────────────────────────────────────────────────────────
async function handlePayout(interaction) {
  const amount   = interaction.options.getInteger('amount');
  const pot      = amount * 2;
  const payout   = Math.floor(pot * (1 - CONFIG.HOUSE_CUT_PERCENT / 100));
  const houseCut = pot - payout;

  const embed = new EmbedBuilder()
    .setColor(0x00b4d8)
    .setTitle('💰 Payout Calculator')
    .addFields(
      { name: '🪙 Each Player Bets', value: `${amount.toLocaleString()} Rocoins`,   inline: true },
      { name: '💰 Winner Gets',      value: `${payout.toLocaleString()} Rocoins`,   inline: true },
      { name: '🏦 House Gets',       value: `${houseCut.toLocaleString()} Rocoins`, inline: true },
    );

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

// ── LOGIN ─────────────────────────────────────────────────────────────────────
client.login(process.env.DISCORD_TOKEN);
