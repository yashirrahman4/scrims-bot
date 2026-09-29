// scrims message templates — DB-backed, runtime-editable via /message_template.
// Port of the source bot's messageTemplateService (JSON file) onto the Prisma
// MessageTemplate model. Seeded from the source's 5 built-in defaults.

const { prisma } = require('../db');

const DEFAULT_TEMPLATES = {
  qualification_idp:
    '{congrats_emoji} **CONGRATULATIONS, {owner_mention}!**\n\n{trophy_emoji} Your team has qualified from:\n\n**{group_type} GROUP {group_number}**\n**Qualified Slot:** {slot_number}\n**Team:** {team_name}\n\nYour team has successfully qualified for the next stage.\n\nPlease stay prepared and wait for further instructions from the management team.\n\nCongratulations once again! {fire_emoji}\n\n━━━━━━━━━━━━━━━━━━━━\n\n✅ **DISQUALIFIED TEAMS CAN NOW RE-REGISTER**',
  qualification_results:
    '{trophy_emoji} **{group_type} RESULT — QUALIFIED TEAM**\n\n**GROUP:** {group_number}\n**SLOT:** {slot_number}\n**TEAM:** {team_name}\n**CAPTAIN:** {owner_mention}\n\nCongratulations to the team for qualifying! The team has successfully cleared this stage and will move forward to the next stage of the tournament.',
  qualification_none_idp:
    '⚪ **{group_type} GROUP {group_number} — QUALIFICATION SKIPPED**\n\nNo team was qualified from this group.\n\n━━━━━━━━━━━━━━━━━━━━\n\n✅ **DISQUALIFIED TEAMS CAN NOW RE-REGISTER**',
  qualification_none_results:
    '⚪ **{group_type} RESULT — NO TEAM QUALIFIED**\n\n**GROUP:** {group_number}\n\nNo team was qualified from this group. The group result has been closed without qualifying any team.',
  ss_idp:
    '{group_mention}\n\n🔐 **ROOM ID / PASSWORD**\n\n**ROOM ID:** `{room_id}`\n**PASSWORD:** `{room_password}`\n**START TIME:** `{start_time}`\n\nPlease join the room on time.',
};

const TEMPLATE_NAMES = Object.keys(DEFAULT_TEMPLATES);

/** {{key}} interpolation; unknown keys are left as-is. Single-brace {key} is also
 *  normalized so legacy rows seeded from the source's format still interpolate. */
function render(content, vars = {}) {
  if (!content) return '';
  const data = { ...vars };
  const normalized = String(content).replace(/(?<!\{)\{([a-zA-Z0-9_]+)\}(?!\})/g, '{{$1}}');
  return normalized.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (match, name) => {
    const value = data[name];
    return value === undefined || value === null ? match : String(value);
  });
}

/** Get a template by name. Seeds from the built-ins on first miss. Returns null for unknown names. */
async function getMessageTemplate(name) {
  const key = String(name || '').trim();
  if (!key) return null;
  try {
    const row = await prisma.messageTemplate.findUnique({ where: { name: key } });
    if (row) return row.content;
    if (DEFAULT_TEMPLATES[key] !== undefined) {
      await prisma.messageTemplate.create({ data: { name: key, content: DEFAULT_TEMPLATES[key] } }).catch(() => null);
      return DEFAULT_TEMPLATES[key];
    }
    return null;
  } catch (err) {
    console.error('[scrimmsgtemplate] getMessageTemplate failed:', err.message);
    return DEFAULT_TEMPLATES[key] !== undefined ? DEFAULT_TEMPLATES[key] : null;
  }
}

/** Upsert a template's content. */
async function setMessageTemplate(name, content) {
  const key = String(name || '').trim();
  if (!key) throw new Error('Template name is required.');
  if (!String(content || '').trim()) throw new Error('Template content cannot be empty.');
  return prisma.messageTemplate.upsert({
    where: { name: key },
    update: { content: String(content) },
    create: { name: key, content: String(content) },
  });
}

/** Render a named template with {{key}} vars. Missing template -> built-in default. */
async function renderTemplate(name, vars = {}) {
  const content = await getMessageTemplate(name);
  if (content === null || content === undefined) {
    throw new Error(`Message template not found: ${name}`);
  }
  return render(content, vars);
}

/** Upsert the 5 built-in defaults only where missing (called at startup). */
async function ensureDefaultTemplates() {
  for (const name of TEMPLATE_NAMES) {
    try {
      const existing = await prisma.messageTemplate.findUnique({ where: { name } });
      if (!existing) {
        await prisma.messageTemplate.create({ data: { name, content: DEFAULT_TEMPLATES[name] } });
      }
    } catch (err) {
      console.error('[scrimmsgtemplate] ensureDefaultTemplates failed:', err.message);
    }
  }
}

module.exports = {
  DEFAULT_TEMPLATES,
  TEMPLATE_NAMES,
  getMessageTemplate,
  setMessageTemplate,
  renderTemplate,
  ensureDefaultTemplates,
  _test: { render },
};
