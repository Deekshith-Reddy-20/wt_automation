#!/usr/bin/env node
// Seed the Suraj Solar CRM configuration into ONE existing account.
//
//   node scripts/seed-suraj-solar.mjs --owner-email you@surajsolar.com
//   node scripts/seed-suraj-solar.mjs --owner-email you@surajsolar.com --with-samples
//
// Creates (idempotently — re-running skips anything that already exists, matched by name):
//   * account name "Suraj Solar", default currency INR
//   * solar custom fields, lead tags, the "Solar Sales" pipeline + stages
//   * 9 example automations — ALWAYS created INACTIVE; review and enable them in
//     Automations. Nothing here sends a WhatsApp message by itself.
//   * DRAFT message templates (never submitted to Meta) and quick replies
//   * the "Suraj Solar — Multilingual WhatsApp Lead Qualification" flow as a DRAFT
//     (src/lib/suraj-solar/lead-flow.ts). An existing flow with that name is left
//     untouched; --update-flow rebuilds its nodes, and never while it is active.
//   * --with-samples: demo contacts/deals with non-routable +91 55555… numbers.
//     Refused against a non-local Supabase unless --allow-remote is also passed.
//
// Credentials come from .env.local (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY).
// Requires Node 22.18+ / 23.6+ (imports the TypeScript flow library directly).

import fs from 'node:fs'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { LEAD_FLOW_CUSTOM_FIELDS, LEAD_FLOW_NAME, LEAD_FLOW_TAGS, buildLeadFlow } from '../src/lib/suraj-solar/lead-flow.ts'
import { AUTOMATION_FALLBACK_LANGUAGE, AUTOMATION_FALLBACK_TEMPLATES } from '../src/lib/suraj-solar/automation-fallbacks.ts'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const opt = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

function loadEnv(file) {
  if (!fs.existsSync(file)) return {}
  const out = {}
  for (const line of fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
  return out
}

const env = { ...loadEnv(path.join(root, '.env.local')), ...process.env }
const ownerEmail = opt('--owner-email')
if (!ownerEmail || !env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Usage: node scripts/seed-suraj-solar.mjs --owner-email <email> [--with-samples [--allow-remote]]')
  console.error('Requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (.env.local).')
  process.exit(2)
}
const isLocal = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(env.NEXT_PUBLIC_SUPABASE_URL)
if (flag('--with-samples') && !isLocal && !flag('--allow-remote')) {
  console.error(`Refusing to insert sample data into non-local Supabase ${env.NEXT_PUBLIC_SUPABASE_URL}. Add --allow-remote for a dev project.`)
  process.exit(2)
}

const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

function must({ data, error }, what) {
  if (error) throw new Error(`${what}: ${error.message}`)
  return data
}

// ------------------------------------------------------------------
// Configuration catalogue
// ------------------------------------------------------------------

// "Customer name" and "Mobile number" are the built-in contact Name / Phone
// columns, so they are deliberately not duplicated as custom fields.
const CUSTOM_FIELDS = [
  ['Location', ['City / area / village']],
  ['Property type', ['Residential', 'Commercial', 'Agricultural', 'Industrial']],
  ['Electricity bill amount', ['Monthly ₹ amount or range']],
  ['Solar requirement', ['On-grid rooftop', 'Off-grid', 'Hybrid', 'Solar water pump', 'Solar water heater']],
  ['Interested capacity (kW)', ['e.g. 3, 5, 10']],
  ['Installation type', ['Rooftop', 'Ground mounted', 'Carport', 'Pump']],
  ['Lead source', ['WhatsApp', 'Website', 'Referral', 'Walk-in', 'Facebook/Instagram', 'Google', 'Exhibition']],
  ['Lead priority', ['High', 'Medium', 'Low']],
  ['Assigned salesperson', ['Team member name']],
  ['Follow-up date', ['YYYY-MM-DD']],
  ['Lead status', ['New Lead', 'Contacted', 'Qualifying', 'Qualified', 'Site Survey', 'Quotation Requested', 'Quotation Sent', 'Negotiation', 'Won', 'Lost']],
]

const TAGS = [
  ['New Enquiry', '#3b82f6'],
  ['Residential', '#22c55e'],
  ['Commercial', '#8b5cf6'],
  ['Agricultural', '#84cc16'],
  ['Hot Lead', '#ef4444'],
  ['Bill Requested', '#f59e0b'],
  ['Bill Received', '#eab308'],
  ['Quotation Requested', '#06b6d4'],
  ['Quotation Sent', '#0ea5e9'],
  ['Follow-up Sent', '#a855f7'],
  ['Do Not Follow Up', '#64748b'],
  ['Needs Human', '#f97316'],
]

const PIPELINE_NAME = 'Solar Sales'
const STAGES = [
  ['New Lead', '#3b82f6'],
  ['Contacted', '#06b6d4'],
  ['Qualified', '#8b5cf6'],
  ['Site Survey', '#f59e0b'],
  ['Quotation Sent', '#0ea5e9'],
  ['Negotiation', '#f97316'],
  ['Won', '#22c55e'],
  ['Lost', '#ef4444'],
]

const TEMPLATES = [
  {
    name: 'solar_quotation_followup',
    category: 'Marketing',
    language: 'en',
    body_text:
      'Hello from Suraj Solar! We are following up on the solar quotation we shared with you. Do you have any questions, or would you like to book a free site survey?',
    footer_text: 'Reply STOP to opt out',
    buttons: [
      { type: 'QUICK_REPLY', text: 'Book site survey' },
      { type: 'QUICK_REPLY', text: 'Talk to an expert' },
    ],
  },
  {
    name: 'solar_site_survey_reminder',
    category: 'Utility',
    language: 'en',
    body_text:
      'Reminder: your Suraj Solar site survey is scheduled for {{1}}. Our engineer will check roof space, shading and your electrical connection. Reply here if you need to reschedule.',
    sample_values: { body: ['18 Oct, 11:00 AM'] },
  },
  {
    name: 'solar_enquiry_reengage',
    category: 'Marketing',
    language: 'en',
    body_text:
      'Planning to cut your electricity bill? Suraj Solar designs and installs rooftop, commercial and agricultural solar systems, and helps eligible customers with subsidy paperwork. Reply INTERESTED for a free consultation.',
    footer_text: 'Reply STOP to opt out',
  },
  {
    name: 'solar_lead_acknowledgement',
    category: 'Utility',
    language: 'en',
    body_text:
      'Hello {{1}}, thank you for your solar enquiry with Suraj Solar. We have recorded your details and a member of our team will review them. Reply here if you would like to add anything.',
    sample_values: { body: ['Ravi'] },
  },
  {
    name: 'solar_callback_confirmation',
    category: 'Utility',
    language: 'en',
    body_text:
      'Hello {{1}}, we have noted your request for a callback from Suraj Solar. Preferred time: {{2}}. Reply here if you would like to change it.',
    sample_values: { body: ['Ravi', 'Evening (4 PM – 7 PM)'] },
  },
  {
    name: 'solar_site_survey_request_ack',
    category: 'Utility',
    language: 'en',
    body_text:
      'Hello {{1}}, we have received your site survey request for {{2}}. Our team will contact you to agree a suitable date before anyone visits.',
    sample_values: { body: ['Ravi', 'Guntur'] },
  },
  {
    name: 'solar_support_handoff',
    category: 'Utility',
    language: 'en',
    body_text:
      'Hello {{1}}, your conversation has been passed to a Suraj Solar team member, who will continue in this chat. You can keep sending your questions here.',
    sample_values: { body: ['Ravi'] },
  },
  // 24h-window fallbacks: the exact text of each automation send_message
  // step, sent as a template once the customer's last message is >24h old.
  ...Object.entries(AUTOMATION_FALLBACK_TEMPLATES).map(([name, body_text]) => ({
    name,
    category: 'Utility',
    language: AUTOMATION_FALLBACK_LANGUAGE,
    body_text,
  })),
]

const QUICK_REPLIES = [
  ['Documents needed', 'To prepare your solar proposal please share: 1) latest electricity bill, 2) property location, 3) roof photos (if available), 4) Aadhaar/ID for subsidy paperwork (only when you decide to proceed).'],
  ['Book site survey', 'Our engineer can visit for a free site survey to check roof space, shading and wiring. Which day and time suit you this week?'],
  ['Subsidy information', 'Eligible residential rooftop systems may qualify for government subsidy. Our team checks your eligibility and handles the application for you — we will confirm the exact amount in your quotation.'],
  ['Quotation shared', 'We have shared your customised solar quotation. Please review it and let us know if you have any questions — we are happy to walk you through it on a call.'],
]

const billList = (rows) => ({
  kind: 'list',
  body: 'To size the right system for you, what is your average monthly electricity bill?',
  button_label: 'Select bill range',
  sections: [{ title: 'Monthly bill', rows }],
  wait_for_reply: true,
})

/** Builds the automation catalogue once tag / field / pipeline ids are known. */
function automationCatalogue({ tag, field, pipelineId, stage }) {
  const setField = (name, value) => ({ step_type: 'update_contact_field', step_config: { field: `custom:${field[name]}`, value } })
  const addTag = (name) => ({ step_type: 'add_tag', step_config: { tag_id: tag[name] } })
  const say = (template_name) => ({
    step_type: 'send_message',
    step_config: {
      text: AUTOMATION_FALLBACK_TEMPLATES[template_name],
      fallback_template: { template_name, language: AUTOMATION_FALLBACK_LANGUAGE },
    },
  })
  const roundRobin = { step_type: 'assign_conversation', step_config: { mode: 'round_robin' } }

  return [
    {
      name: 'Suraj Solar · New WhatsApp enquiry',
      description: 'First message from any contact: records the lead source, opens a deal in New Lead and asks what kind of property the solar system is for.',
      trigger_type: 'first_inbound_message',
      trigger_config: {},
      steps: [
        setField('Lead source', 'WhatsApp'),
        setField('Lead status', 'New Lead'),
        addTag('New Enquiry'),
        { step_type: 'create_deal', step_config: { pipeline_id: pipelineId, stage_id: stage['New Lead'], title: 'WhatsApp solar enquiry', value: 0 } },
        {
          step_type: 'send_buttons',
          step_config: {
            kind: 'buttons',
            header: 'Welcome to Suraj Solar',
            body: 'Namaste! Thank you for contacting Suraj Solar. Which type of property is the solar system for?',
            footer: 'surajsolar.com',
            buttons: [
              { id: 'solar_residential', title: 'Residential' },
              { id: 'solar_commercial', title: 'Commercial' },
              { id: 'solar_agricultural', title: 'Agricultural' },
            ],
          },
        },
      ],
    },
    {
      name: 'Suraj Solar · Residential enquiry',
      description: 'Customer tapped "Residential": tags the lead, captures the monthly bill range and asks for location + a bill photo.',
      trigger_type: 'interactive_reply',
      trigger_config: { reply_ids: ['solar_residential'] },
      steps: [
        addTag('Residential'),
        setField('Property type', 'Residential'),
        setField('Installation type', 'Rooftop'),
        {
          step_type: 'send_list',
          step_config: billList([
            { id: 'res_bill_lt_2000', title: 'Below ₹2,000' },
            { id: 'res_bill_2000_5000', title: '₹2,000 – ₹5,000' },
            { id: 'res_bill_5000_10000', title: '₹5,000 – ₹10,000' },
            { id: 'res_bill_gt_10000', title: 'Above ₹10,000' },
          ]),
        },
        setField('Electricity bill amount', '{{message.text}}'),
        setField('Lead status', 'Qualifying'),
        addTag('Bill Requested'),
        say('solar_residential_details'),
      ],
    },
    {
      name: 'Suraj Solar · Commercial enquiry',
      description: 'Customer tapped "Commercial": marks the lead high priority, captures the bill range and assigns a salesperson.',
      trigger_type: 'interactive_reply',
      trigger_config: { reply_ids: ['solar_commercial'] },
      steps: [
        addTag('Commercial'),
        setField('Property type', 'Commercial'),
        setField('Lead priority', 'High'),
        {
          step_type: 'send_list',
          step_config: billList([
            { id: 'com_bill_lt_10000', title: 'Below ₹10,000' },
            { id: 'com_bill_10000_50000', title: '₹10,000 – ₹50,000' },
            { id: 'com_bill_50000_100000', title: '₹50,000 – ₹1 lakh' },
            { id: 'com_bill_gt_100000', title: 'Above ₹1 lakh' },
          ]),
        },
        setField('Electricity bill amount', '{{message.text}}'),
        setField('Lead status', 'Qualifying'),
        roundRobin,
        say('solar_commercial_details'),
      ],
    },
    {
      name: 'Suraj Solar · Agricultural enquiry',
      description: 'Customer tapped "Agricultural": captures which agri-solar solution they want and asks for farm details.',
      trigger_type: 'interactive_reply',
      trigger_config: { reply_ids: ['solar_agricultural'] },
      steps: [
        addTag('Agricultural'),
        setField('Property type', 'Agricultural'),
        {
          step_type: 'send_buttons',
          step_config: {
            kind: 'buttons',
            body: 'Which agricultural solar solution are you interested in?',
            buttons: [
              { id: 'agri_pump', title: 'Solar water pump' },
              { id: 'agri_grid', title: 'On-grid farm plant' },
              { id: 'agri_unsure', title: 'Need guidance' },
            ],
            wait_for_reply: true,
          },
        },
        setField('Solar requirement', '{{message.text}}'),
        setField('Lead status', 'Qualifying'),
        say('solar_agricultural_details'),
      ],
    },
    {
      name: 'Suraj Solar · Electricity bill collection',
      description: 'Customer mentions their bill: asks for a clear photo/PDF of the latest bill and tags the lead.',
      trigger_type: 'keyword_match',
      trigger_config: { keywords: ['bill', 'electricity bill', 'light bill', 'bijli bill'], match_type: 'word' },
      steps: [
        addTag('Bill Requested'),
        say('solar_bill_request'),
      ],
    },
    {
      name: 'Suraj Solar · Sales agent assignment',
      description: 'When an agent tags a contact "Hot Lead": sets priority High and assigns the conversation to the least-loaded salesperson.',
      trigger_type: 'tag_added',
      trigger_config: { tag_id: tag['Hot Lead'] },
      steps: [setField('Lead priority', 'High'), roundRobin],
    },
    {
      name: 'Suraj Solar · Quotation request',
      description: 'Customer asks for a price/quotation: tags the lead, updates status, lists what is needed and assigns a salesperson.',
      trigger_type: 'keyword_match',
      trigger_config: { keywords: ['quotation', 'quote', 'price', 'cost', 'rate', 'estimate'], match_type: 'word' },
      steps: [
        addTag('Quotation Requested'),
        setField('Lead status', 'Quotation Requested'),
        say('solar_quotation_details'),
        roundRobin,
      ],
    },
    {
      name: 'Suraj Solar · Quotation follow-up reminder',
      description: 'Two days after an agent tags "Quotation Sent", sends the approved follow-up template unless the contact is tagged "Do Not Follow Up". Uses a template because the 24-hour session window has usually closed.',
      trigger_type: 'tag_added',
      trigger_config: { tag_id: tag['Quotation Sent'] },
      steps: [
        setField('Lead status', 'Quotation Sent'),
        { step_type: 'wait', step_config: { amount: 2, unit: 'days' } },
        {
          step_type: 'condition',
          step_config: { subject: 'tag_presence', operand: tag['Do Not Follow Up'] },
          branches: {
            yes: [],
            no: [
              { step_type: 'send_template', step_config: { template_name: 'solar_quotation_followup', language: 'en' } },
              addTag('Follow-up Sent'),
            ],
          },
        },
      ],
    },
    {
      name: 'Suraj Solar · Human agent escalation',
      description: 'Customer asks for a person: tags "Needs Human", assigns a salesperson and confirms the handoff.',
      trigger_type: 'keyword_match',
      trigger_config: { keywords: ['agent', 'human', 'call me', 'callback', 'talk to', 'executive', 'speak to someone'], match_type: 'word' },
      steps: [
        addTag('Needs Human'),
        roundRobin,
        say('solar_human_handoff'),
      ],
    },
  ]
}

const SAMPLE_CONTACTS = [
  { name: 'Ramesh Patil', phone: '+915555500001', stage: 'New Lead', value: 0, tags: ['New Enquiry', 'Residential'],
    fields: { Location: 'Pune, Kothrud', 'Property type': 'Residential', 'Electricity bill amount': '₹3,500', 'Solar requirement': 'On-grid rooftop', 'Interested capacity (kW)': '3', 'Installation type': 'Rooftop', 'Lead source': 'WhatsApp', 'Lead priority': 'Medium', 'Lead status': 'New Lead' } },
  { name: 'Sunita Deshmukh', phone: '+915555500002', stage: 'Contacted', value: 185000, tags: ['Residential', 'Bill Received'],
    fields: { Location: 'Nashik', 'Property type': 'Residential', 'Electricity bill amount': '₹5,000 – ₹10,000', 'Solar requirement': 'On-grid rooftop', 'Interested capacity (kW)': '5', 'Installation type': 'Rooftop', 'Lead source': 'Website', 'Lead priority': 'Medium', 'Lead status': 'Contacted', 'Follow-up date': '2026-10-20' } },
  { name: 'Shree Ganesh Traders', phone: '+915555500003', stage: 'Site Survey', value: 1250000, tags: ['Commercial', 'Hot Lead'],
    fields: { Location: 'Aurangabad MIDC', 'Property type': 'Commercial', 'Electricity bill amount': '₹50,000 – ₹1 lakh', 'Solar requirement': 'On-grid rooftop', 'Interested capacity (kW)': '40', 'Installation type': 'Rooftop', 'Lead source': 'Referral', 'Lead priority': 'High', 'Lead status': 'Site Survey', 'Follow-up date': '2026-10-19' } },
  { name: 'Vitthal Jadhav', phone: '+915555500004', stage: 'Qualified', value: 320000, tags: ['Agricultural'],
    fields: { Location: 'Baramati, Pune district', 'Property type': 'Agricultural', 'Solar requirement': 'Solar water pump', 'Interested capacity (kW)': '5 HP', 'Installation type': 'Pump', 'Lead source': 'Exhibition', 'Lead priority': 'Medium', 'Lead status': 'Qualified' } },
  { name: 'Anjali Kulkarni', phone: '+915555500005', stage: 'Quotation Sent', value: 240000, tags: ['Residential', 'Quotation Sent'],
    fields: { Location: 'Satara', 'Property type': 'Residential', 'Electricity bill amount': '₹4,200', 'Solar requirement': 'Hybrid', 'Interested capacity (kW)': '4', 'Installation type': 'Rooftop', 'Lead source': 'Facebook/Instagram', 'Lead priority': 'High', 'Lead status': 'Quotation Sent', 'Follow-up date': '2026-10-21' } },
  { name: 'Hotel Sahyadri', phone: '+915555500006', stage: 'Negotiation', value: 2100000, tags: ['Commercial', 'Hot Lead', 'Quotation Sent'],
    fields: { Location: 'Mahabaleshwar', 'Property type': 'Commercial', 'Electricity bill amount': 'Above ₹1 lakh', 'Solar requirement': 'On-grid rooftop', 'Interested capacity (kW)': '75', 'Installation type': 'Rooftop + carport', 'Lead source': 'Google', 'Lead priority': 'High', 'Lead status': 'Negotiation', 'Follow-up date': '2026-10-18' } },
  { name: 'Prakash More', phone: '+915555500007', stage: 'Won', value: 210000, status: 'won', tags: ['Residential'],
    fields: { Location: 'Kolhapur', 'Property type': 'Residential', 'Interested capacity (kW)': '3', 'Installation type': 'Rooftop', 'Lead source': 'Referral', 'Lead status': 'Won' } },
  { name: 'Deepak Shinde', phone: '+915555500008', stage: 'Lost', value: 150000, status: 'lost', tags: ['Residential', 'Do Not Follow Up'],
    fields: { Location: 'Solapur', 'Property type': 'Residential', 'Lead source': 'WhatsApp', 'Lead status': 'Lost' } },
]

// ------------------------------------------------------------------
// Seeding
// ------------------------------------------------------------------

async function main() {
  const users = must(await db.auth.admin.listUsers({ perPage: 1000 }), 'list users').users
  const owner = users.find((u) => u.email?.toLowerCase() === ownerEmail.toLowerCase())
  if (!owner) throw new Error(`No user with email ${ownerEmail}. Sign up in the app first.`)
  const profile = must(await db.from('profiles').select('id, account_id, account_role').eq('user_id', owner.id).single(), 'load profile')
  if (!['owner', 'admin'].includes(profile.account_role)) throw new Error(`${ownerEmail} is ${profile.account_role}; must be owner/admin.`)
  const accountId = profile.account_id
  const base = { account_id: accountId, user_id: owner.id }
  const counts = {}
  const bump = (k) => (counts[k] = (counts[k] ?? 0) + 1)

  must(await db.from('accounts').update({ name: 'Suraj Solar', default_currency: 'INR' }).eq('id', accountId), 'update account')

  // Custom fields
  const existingFields = must(await db.from('custom_fields').select('id, field_name').eq('account_id', accountId), 'load fields')
  const field = Object.fromEntries(existingFields.map((f) => [f.field_name, f.id]))
  for (const [name, suggested] of [...CUSTOM_FIELDS, ...LEAD_FLOW_CUSTOM_FIELDS]) {
    if (field[name]) continue
    const row = must(await db.from('custom_fields').insert({ ...base, field_name: name, field_type: 'text', field_options: { suggested_values: suggested } }).select('id').single(), `field ${name}`)
    field[name] = row.id
    bump('custom fields')
  }

  // Tags
  const existingTags = must(await db.from('tags').select('id, name').eq('account_id', accountId), 'load tags')
  const tag = Object.fromEntries(existingTags.map((t) => [t.name, t.id]))
  for (const [name, color] of TAGS) {
    if (tag[name]) continue
    tag[name] = must(await db.from('tags').insert({ ...base, name, color }).select('id').single(), `tag ${name}`).id
    bump('tags')
  }

  // Pipeline + stages
  let pipeline = must(await db.from('pipelines').select('id').eq('account_id', accountId).eq('name', PIPELINE_NAME).maybeSingle(), 'load pipeline')
  if (!pipeline) {
    pipeline = must(await db.from('pipelines').insert({ ...base, name: PIPELINE_NAME }).select('id').single(), 'create pipeline')
    bump('pipelines')
  }
  const existingStages = must(await db.from('pipeline_stages').select('id, name').eq('pipeline_id', pipeline.id), 'load stages')
  const stage = Object.fromEntries(existingStages.map((s) => [s.name, s.id]))
  for (const [i, [name, color]] of STAGES.entries()) {
    if (stage[name]) continue
    stage[name] = must(await db.from('pipeline_stages').insert({ pipeline_id: pipeline.id, name, color, position: i }).select('id').single(), `stage ${name}`).id
    bump('pipeline stages')
  }

  // Templates (DRAFT — submit from Settings → Templates once the WABA is connected)
  for (const tpl of TEMPLATES) {
    const exists = must(await db.from('message_templates').select('id').eq('account_id', accountId).eq('name', tpl.name).maybeSingle(), `template ${tpl.name}`)
    if (exists) continue
    must(await db.from('message_templates').insert({ ...base, status: 'DRAFT', ...tpl }), `template ${tpl.name}`)
    bump('draft templates')
  }

  // Quick replies
  for (const [title, content_text] of QUICK_REPLIES) {
    const exists = must(await db.from('quick_replies').select('id').eq('account_id', accountId).eq('title', title).maybeSingle(), `quick reply ${title}`)
    if (exists) continue
    must(await db.from('quick_replies').insert({ ...base, title, kind: 'text', content_text }), `quick reply ${title}`)
    bump('quick replies')
  }

  // Automations — inactive
  for (const a of automationCatalogue({ tag, field, pipelineId: pipeline.id, stage })) {
    const exists = must(await db.from('automations').select('id').eq('account_id', accountId).eq('name', a.name).maybeSingle(), `automation ${a.name}`)
    if (exists) continue
    const created = must(await db.from('automations').insert({
      ...base, name: a.name, description: a.description, trigger_type: a.trigger_type, trigger_config: a.trigger_config, is_active: false,
    }).select('id').single(), `automation ${a.name}`)
    must(await db.from('automation_steps').insert(flatten(created.id, a.steps)), `steps for ${a.name}`)
    bump('automations (inactive)')
  }

  await seedLeadFlow({ base, accountId, field, tag, bump })

  if (flag('--with-samples')) await seedSamples({ base, accountId, profileId: profile.id, field, tag, pipelineId: pipeline.id, stage, bump })

  console.log(`Seeded account ${accountId} (${ownerEmail}) as "Suraj Solar", currency INR.`)
  const entries = Object.entries(counts)
  console.log(entries.length ? entries.map(([k, v]) => `  + ${v} ${k}`).join('\n') : '  nothing new — already seeded')
}

/** Creates the lead-qualification flow as a draft; see the header for update rules. */
async function seedLeadFlow({ base, accountId, field, tag, bump }) {
  const def = buildLeadFlow({
    fields: field,
    tags: { [LEAD_FLOW_TAGS.newEnquiry]: tag[LEAD_FLOW_TAGS.newEnquiry], [LEAD_FLOW_TAGS.hot]: tag[LEAD_FLOW_TAGS.hot] },
  })
  const flowRow = {
    name: def.name,
    description: def.description,
    trigger_type: def.trigger_type,
    trigger_config: def.trigger_config,
    entry_node_id: def.entry_node_id,
    fallback_policy: def.fallback_policy,
  }
  const existing = must(await db.from('flows').select('id, status').eq('account_id', accountId).eq('name', LEAD_FLOW_NAME).limit(1).maybeSingle(), 'load lead flow')

  if (existing && !flag('--update-flow')) return
  // The flow's update_contact / score_lead nodes are rejected by the
  // flow_nodes CHECK constraint until migration 055 is applied.
  const { error: optOutColumn } = await db.from('contacts').select('opted_out_at').limit(1)
  if (optOutColumn) {
    console.warn(
      `Skipped "${LEAD_FLOW_NAME}": migration 055_flow_lead_capture_and_opt_out.sql is not applied ` +
        `(${optOutColumn.code ?? optOutColumn.message}). Run it in the Supabase SQL Editor, then re-run this script.`,
    )
    return
  }
  if (existing && existing.status === 'active') {
    console.warn(`"${LEAD_FLOW_NAME}" is active — pause it in Flows before running --update-flow.`)
    return
  }

  let flowId = existing?.id
  if (existing) {
    must(await db.from('flows').update({ ...flowRow, updated_at: new Date().toISOString() }).eq('id', flowId), 'update lead flow')
    must(await db.from('flow_nodes').delete().eq('flow_id', flowId), 'clear lead flow nodes')
  } else {
    flowId = must(await db.from('flows').insert({ ...base, ...flowRow, status: 'draft' }).select('id').single(), 'create lead flow').id
  }
  const { error: nodesError } = await db.from('flow_nodes').insert(def.nodes.map((n) => ({ flow_id: flowId, ...n })))
  if (nodesError) {
    // A flow row without nodes would show as installed-but-broken; remove a row we just created.
    if (!existing) await db.from('flows').delete().eq('id', flowId)
    throw new Error(`lead flow nodes: ${nodesError.message}`)
  }
  bump(existing ? 'flows updated (draft)' : 'flows (draft)')
}

/** Same row shape the automation builder writes (see src/lib/automations/steps-tree.ts). */
function flatten(automationId, steps, parentId = null, branch = null, out = []) {
  steps.forEach((s, position) => {
    const id = crypto.randomUUID()
    out.push({ id, automation_id: automationId, parent_step_id: parentId, branch, step_type: s.step_type, step_config: s.step_config, position })
    if (s.step_type === 'condition' && s.branches) {
      flatten(automationId, s.branches.yes ?? [], id, 'yes', out)
      flatten(automationId, s.branches.no ?? [], id, 'no', out)
    }
  })
  return out
}

async function seedSamples({ base, accountId, profileId, field, tag, pipelineId, stage, bump }) {
  for (const c of SAMPLE_CONTACTS) {
    let contact = must(await db.from('contacts').select('id').eq('account_id', accountId).eq('phone', c.phone).maybeSingle(), `contact ${c.name}`)
    if (contact) continue
    contact = must(await db.from('contacts').insert({ ...base, name: c.name, phone: c.phone, company: c.name.includes(' ') && /Traders|Hotel/.test(c.name) ? c.name : null }).select('id').single(), `contact ${c.name}`)
    bump('sample contacts')

    const values = Object.entries(c.fields).map(([name, value]) => ({ contact_id: contact.id, custom_field_id: field[name], value }))
    must(await db.from('contact_custom_values').insert(values), `values for ${c.name}`)
    must(await db.from('contact_tags').insert(c.tags.map((t) => ({ contact_id: contact.id, tag_id: tag[t] }))), `tags for ${c.name}`)
    must(await db.from('contact_notes').insert({ ...base, contact_id: contact.id, note_text: `[Sample data] ${c.fields['Lead source'] ?? 'Unknown'} lead — ${c.fields['Lead status']}.` }), `note for ${c.name}`)

    const conv = must(await db.from('conversations').insert({
      ...base, contact_id: contact.id, status: c.status ? 'closed' : 'open', last_message_text: 'Sample conversation (demo data)', last_message_at: new Date().toISOString(),
    }).select('id').single(), `conversation for ${c.name}`)
    must(await db.from('messages').insert([
      { conversation_id: conv.id, sender_type: 'customer', content_type: 'text', content_text: `Hi, I am interested in solar for my ${(c.fields['Property type'] ?? 'property').toLowerCase()} in ${c.fields.Location ?? 'Maharashtra'}.`, status: 'delivered' },
      { conversation_id: conv.id, sender_type: 'agent', sender_id: base.user_id, content_type: 'text', content_text: 'Thank you for contacting Suraj Solar! (sample message — never sent)', status: 'read' },
    ]), `messages for ${c.name}`)

    must(await db.from('deals').insert({
      ...base, pipeline_id: pipelineId, stage_id: stage[c.stage], contact_id: contact.id, conversation_id: conv.id,
      title: `${c.fields['Interested capacity (kW)'] ? `${c.fields['Interested capacity (kW)']} ` : ''}${c.fields['Property type'] ?? ''} solar — ${c.name}`.replace(/\s+/g, ' ').trim(),
      value: c.value, currency: 'INR', status: c.status ?? 'open', assigned_to: profileId,
      expected_close_date: c.fields['Follow-up date'] ?? null, notes: 'Sample deal (demo data)',
    }), `deal for ${c.name}`)
    bump('sample deals')
  }
}

main().catch((err) => {
  console.error(err.message ?? err)
  process.exit(1)
})
