import express from 'express';
import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';
import OpenAI from 'openai';
dotenv.config();

const app = express();
const prisma = new PrismaClient();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Resend API for email
async function sendEmail(to: string, subject: string, html: string) {
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_API_KEY) { console.error('RESEND_API_KEY not set'); return; }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM || 'Third Eye Consultancy <onboarding@resend.dev>',
      to: [to],
      subject,
      html,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Resend error: ${JSON.stringify(data)}`);
  return data;
}

// Twilio SMS
async function sendSMS(to: string, body: string) {
  const SID = process.env.TWILIO_ACCOUNT_SID;
  const TOKEN = process.env.TWILIO_AUTH_TOKEN;
  const FROM = process.env.TWILIO_PHONE_NUMBER;
  if (!SID || !TOKEN || !FROM) { console.log('Twilio not configured'); return; }
  const url = `https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages.json`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${SID}:${TOKEN}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ To: to, From: FROM, Body: body }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Twilio SMS error: ${JSON.stringify(data)}`);
  return data;
}

// Twilio WhatsApp
async function sendWhatsApp(to: string, body: string) {
  const SID = process.env.TWILIO_ACCOUNT_SID;
  const TOKEN = process.env.TWILIO_AUTH_TOKEN;
  const FROM = process.env.TWILIO_WHATSAPP_NUMBER || 'whatsapp:+14155238886';
  if (!SID || !TOKEN) { console.log('Twilio not configured'); return; }
  const url = `https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages.json`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${SID}:${TOKEN}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ To: `whatsapp:${to}`, From: FROM, Body: body }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`WhatsApp error: ${JSON.stringify(data)}`);
  return data;
}

// OpenAI
const openai = process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY !== 'YOUR_KEY_HERE'
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

function extractFormSummary(answers: any[]): string {
  return answers.map((a: any) => {
    let val = '';
    if (a.type === 'text' || a.type === 'short_text' || a.type === 'long_text') val = a.text;
    else if (a.type === 'email') val = a.email;
    else if (a.type === 'choice') val = a.choice?.label;
    else if (a.type === 'choices') val = a.choices?.labels?.join(', ');
    else if (a.type === 'number') val = String(a.number);
    else if (a.type === 'phone_number') val = a.phone_number;
    else val = JSON.stringify(a);
    const title = a.field?.title || a.field?.ref || 'unknown';
    return `${title}: ${val}`;
  }).join('\n');
}

async function generatePersonalizedContent(
  firstName: string,
  company: string,
  formSummary: string,
  channel: 'email' | 'sms'
): Promise<{ subject: string; body: string }> {
  if (!openai) return getFallbackContent(firstName, channel);
  try {
    const isEmail = channel === 'email';
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are a copywriter for Third Eye Consultancy, a premium consultancy for artists, brands, venues, and enterprises. Services: creative strategy, AI automation, marketing, event production. Brand voice: confident, visionary, sharp, warm but professional. Tagline: "Let's see further together."

Write a personalized ${isEmail ? 'confirmation email' : 'SMS text message'} to a new lead who submitted an intake form.
${isEmail ? `Rules:
- Address by first name
- Reference their company/industry if provided
- Acknowledge their goals/pain points from form
- Hint at how Third Eye can help THEM specifically
- 3-4 short paragraphs max, under 200 words
- End with: a team member will reach out within 24-48 hours
- Do NOT include subject in body
- Sound human
Respond in JSON: {"subject": "...", "body": "..."}` : `Rules:
- Under 160 characters ideally, 320 max
- Address by first name
- Confirm receipt, mention 24-48hr follow-up
- Brand voice: warm, confident
- End with opt-out: Reply STOP to opt out
Respond in JSON: {"subject": "", "body": "..."}`}`,
        },
        {
          role: 'user',
          content: `Lead: ${firstName} | Company: ${company || 'N/A'}\n\nForm answers:\n${formSummary}`,
        },
      ],
      temperature: 0.8,
      max_tokens: isEmail ? 500 : 150,
    });
    const raw = completion.choices[0]?.message?.content || '';
    const parsed = JSON.parse(raw);
    return { subject: parsed.subject || 'We see you — Third Eye Consultancy', body: parsed.body || '' };
  } catch (err) {
    console.error('OpenAI failed, using fallback:', err);
    return getFallbackContent(firstName, channel);
  }
}

function getFallbackContent(firstName: string, channel: 'email' | 'sms') {
  if (channel === 'sms') {
    return {
      subject: '',
      body: `Hey ${firstName || 'there'}! Third Eye Consultancy here. We got your submission and will reach out within 24-48hrs. Reply STOP to opt out.`,
    };
  }
  return {
    subject: 'We see you — Third Eye Consultancy',
    body: `Hey ${firstName || 'there'},\n\nThank you for reaching out to Third Eye Consultancy. We received your intake form and are reviewing your details now.\n\nA member of our team will be in touch within 24-48 hours to discuss next steps.\n\nThird Eye Consultancy — Let's see further together.`,
  };
}

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Typeform webhook
app.post('/webhooks/typeform', async (req, res) => {
  try {
    const payload = req.body;
    const answers = payload?.form_response?.answers || [];

    // Extract fields
    const data: any = { source: 'typeform', formData: payload };
    let phone = '';
    let contactPreference = 'email'; // default

    for (const answer of answers) {
      const title = (answer.field?.title || '').toLowerCase();
      const ref = answer.field?.ref || '';

      // Name
      if (title.includes('name') || title.includes('first name')) {
        data.firstName = answer.text || answer.email || '';
      }
      // Email
      if (answer.type === 'email') {
        data.email = answer.email;
      }
      // Company
      if (title.includes('company') || title.includes('brand') || title.includes('organization')) {
        data.company = answer.text || '';
      }
      // Phone
      if (answer.type === 'phone_number') {
        phone = answer.phone_number;
      }
      if (title.includes('phone') && (answer.type === 'text' || answer.type === 'short_text')) {
        phone = answer.text || '';
      }
      // Contact preference
      if (title.includes('contact') || title.includes('prefer') || title.includes('reach')) {
        const val = (answer.choice?.label || answer.text || '').toLowerCase();
        if (val.includes('text') || val.includes('sms') || val.includes('whatsapp')) {
          contactPreference = 'sms';
        } else if (val.includes('email')) {
          contactPreference = 'email';
        }
      }

      // Fallback field map by ref
      if (ref === 'ce5c3b24-dcc7-4ec8-8a53-131301cc99e9') data.firstName = answer.text || '';
      if (ref === '521f13d1-683f-4745-9a9a-c3aed1c3fa64') data.email = answer.email || '';
      if (ref === 'df36d843-3fcf-4b8b-b694-e8d1a075bb52') data.company = answer.text || '';
    }

    if (phone) data.phone = phone;

    if (!data.email) {
      return res.status(400).json({ error: 'No email found in submission' });
    }

    // Upsert lead
    const lead = await prisma.lead.upsert({
      where: { email: data.email },
      update: { formData: data.formData, phone: phone || undefined },
      create: data,
    });
    console.log(`Lead upserted: ${lead.id} (${lead.email}) | preference: ${contactPreference}`);

    const formSummary = extractFormSummary(answers);

    // Route by contact preference
    if (contactPreference === 'sms' && phone) {
      // SMS + WhatsApp
      const content = await generatePersonalizedContent(lead.firstName || '', data.company || '', formSummary, 'sms');
      try {
        await sendSMS(phone, content.body);
        console.log(`SMS sent to ${phone}`);
      } catch (e) { console.error('SMS failed:', e); }
      try {
        await sendWhatsApp(phone, content.body);
        console.log(`WhatsApp sent to ${phone}`);
      } catch (e) { console.error('WhatsApp failed:', e); }
    } else {
      // Email (default)
      const content = await generatePersonalizedContent(lead.firstName || '', data.company || '', formSummary, 'email');
      const html = `
        <div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:600px;margin:0 auto;background:#3B0764;color:#E8EAF6;padding:40px;border-radius:12px;">
          <h2 style="color:#fff;margin-bottom:24px;font-weight:600;">${content.subject}</h2>
          <div style="font-size:15px;line-height:1.8;white-space:pre-line;">${content.body}</div>
          <hr style="border:1px solid #5B21B6;margin:28px 0;"/>
          <p style="font-size:13px;color:#A78BFA;margin:0;">Third Eye Consultancy — Let's see further together.</p>
        </div>
      `;
      try {
        await sendEmail(lead.email, content.subject, html);
        console.log(`Email sent to ${lead.email}`);
      } catch (e) { console.error('Email failed:', e); }

      // Also send SMS if phone provided, as bonus notification
      if (phone) {
        const smsContent = await generatePersonalizedContent(lead.firstName || '', data.company || '', formSummary, 'sms');
        try { await sendSMS(phone, smsContent.body); } catch (e) { console.error('Bonus SMS failed:', e); }
      }
    }

    res.json({ success: true, leadId: lead.id, channel: contactPreference });
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get all leads
app.get('/leads', async (req, res) => {
  try {
    const leads = await prisma.lead.findMany({ orderBy: { createdAt: 'desc' }, take: 100 });
    res.json(leads);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch leads' });
  }
});

app.listen(PORT, () => {
  console.log(`Crescendo backend running on port ${PORT}`);
});

export default app;
