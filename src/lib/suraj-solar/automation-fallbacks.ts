/**
 * Suraj Solar automation reply texts, keyed by the WhatsApp template that
 * mirrors each one word-for-word. The automation engine sends the template
 * instead of the text when the customer's last message is older than
 * Meta's 24-hour customer-service window.
 *
 * Template bodies must stay identical to the automation text: Meta approves
 * the exact wording, so edit both together and resubmit the template.
 */
export const AUTOMATION_FALLBACK_TEMPLATES = {
  solar_residential_details:
    'Thank you! Please share your location (city/area) and, if possible, a photo of your latest electricity bill. A Suraj Solar expert will recommend the right rooftop system for your home.',
  solar_commercial_details:
    'Thank you. Please share your business name, site location and sanctioned load (kW) if known. Our commercial solar team will contact you shortly.',
  solar_agricultural_details:
    'Please share your village/taluka, current pump capacity (HP) and water source (borewell / open well / canal). Our agri-solar team will guide you, including subsidy eligibility.',
  solar_bill_request:
    'Please send a clear photo or PDF of your latest electricity bill showing units consumed and sanctioned load. This helps us size your solar system accurately.',
  solar_quotation_details:
    'Thanks for your interest! To prepare an accurate quotation please confirm: 1) location, 2) monthly bill or units, 3) roof/space available, 4) preferred capacity in kW (if known). A Suraj Solar expert will share your quotation soon.',
  solar_human_handoff:
    'Sure — we are connecting you with a Suraj Solar expert. They will reply here shortly (Mon–Sat, 9 AM – 7 PM).',
} as const

export type AutomationFallbackTemplateName = keyof typeof AUTOMATION_FALLBACK_TEMPLATES

export const AUTOMATION_FALLBACK_LANGUAGE = 'en'
