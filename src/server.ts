import express from 'express';
import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';
import OpenAI from 'openai';

dotenv.config();

const app = express();
const prisma = new PrismaClient();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Resend API for email (Railway blocks SMTP)
async function sendEmail(to: string, subject: string, html: string) {
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_API_KEY) {
    console.error('RESEND_API_KEY not set, skipping email');
    return;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM || 'Third Eye Consultancy <onboarding@resend.dev>',
      to: [to],
      subject,
      html,
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Resend error: ${JSON.stringify(data)}`);
  }
  return data;
}

// Twilio SMS/WhatsApp
async function sendSMS(to: string, body: string) {
  const SID = process.env.TWILIO_ACCOUNT_SID;
  const TOKEN = process.env.TWILIO_AUTH_TOKEN;
  const FROM = process.env.TWILIO_PHONE_NUMBER;
  if (!SID || !TOKEN || !FROM) {
    console.log('Twilio not configured, skipping SMS');
    return;
  }
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
  console.log(`SMS sent to ${to}`);
  return data;
}

async function sendWhatsApp(to: string, body: string) {
  const SID = process.env.TWILIO_ACCOUNT_SID;
  const TOKEN = process.env.TWILIO_AUTH_TOKEN;
  const FROM = process.env.TWILIO_WHATSAPP_NUMBER || 'whatsapp:+14155238886';
  if (!SID || !TOKEN) {
    console.log('Twilio not configured, skipping WhatsApp');
    return;
  }
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
  if (!res.ok) throw new Error(`Twilio WhatsApp error: ${JSON.stringify(data)}`);
  console.log(`WhatsApp sent to ${to}`);
  return data;
}

// OpenAI client (only if key exists and not placeholder)
const openai = process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY !== 'YOUR_KEY_HERE'
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

// Extract readable answers from Typeform payload
function extractFormSummary(answers: any[]): string {
  return answers.map((a: any) => {
    const q = a.field?.ref || 'unknown';
    let val = '';
    if (a.type === 'text' || a.type === 'short_text') val = a.text;
    else if (a.type === 'email') val = a.email;
    else if (a.type === 'choice') val = a.choice?.label;
    else if (a.type === 'choices') val = a.choices?.labels?.join(', ');
    else if (a.type === 'number') val = String(a.number);
    else if (a.type === 'long_text') val = a.text;
    else val = JSON.stringify(a);
    const title = a.field?.title || q;
    return `${title}: ${val}`;
  }).join('\n');
}

// Generate personalized email using OpenAI
async function generatePersonalizedEmail(
  firstName: string,
  company: string,
  formSummary: string
): Promise<{ subject: string; body: string }> {
  if (!openai) {
    return getFallbackEmail(firstName);
  }
  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are a copywriter for Third Eye Consultancy, a premium consultancy that helps artists, brands, venues, and enterprises with creative strategy, AI automation, marketing, and event production.
Brand voice: confident, visionary, sharp, warm but professional. You see what others miss. Tagline: "Let's see further together."
Write a personalized outreach confirmation email to a new lead who just submitted an intake form. The email should:
- Address them by first name
- Reference their specific company/organization if provided
- Acknowledge their industry, goals, priorities, and pain points based on their form answers
- Briefly hint at how Third Eye can specifically help THEM (not generic services)
- Be concise (3-4 short paragraphs max)
- End with a note that a team member will reach out within 24-48 hours
- Do NOT include a subject line in the body
- Do NOT use placeholder brackets like [Name]
- Sound human, not robotic
Respond in JSON format:
{"subject": "...", "body": "..."}
The body should be plain text (no HTML). Keep it under 200 words.`
        },
        {
          role: 'user',
          content: `New lead submission:\n\nName: ${firstName}\nCompany: ${company || 'Not provided'}\n\nForm answers:\n${formSummary}`
        }
      ],
      temperature: 0.8,
      max_tokens: 500,
    });
    const raw = completion.choices[0]?.message?.content || '';
    const parsed = JSON.parse(raw);
    return {
      subject: parsed.subject || 'We see you \u2014 Third Eye Consultancy',
      body: parsed.body || '',
    };
  } catch (err) {
    console.error('OpenAI generation failed, using fallback:', err);
    return getFallbackEmail(firstName);
  }
}

function getFallbackEmail(firstName: string) {
  return {
    subject: 'We see you \u2014 Third Eye Consultancy',
    body: `Hey ${firstName || 'there'},\n\nThank you for reaching out to Third Eye Consultancy. We received your intake form and are reviewing your details now.\n\nA member of our team will be in touch within 24\u201348 hours to discuss next steps.\n\nIn the meantime, feel free to reply to this email with any additional details about your project.\n\nThird Eye Consultancy \u2014 Let\u2019s see further together.`
  };
}

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Typeform webhook intake
app.post('/webhooks/typeform', async (req, res) => {
  try {
    const payload = req.body;
    const answers = payload?.form_response?.answers || [];
    const hidden = payload?.form_response?.hidden || {};

    // Typeform field ref -> Prisma Lead field
    const FIELD_MAP: Record<string, string> = {
      'ce5c3b24-dcc7-4ec8-8a53-131301cc99e9': 'firstName',
      '521f13d1-683f-4745-9a9a-c3aed1c3fa64': 'email',
      'df36d843-3fcf-4b8b-b694-e8d1a075bb52': 'company',
    };

    const data: any = { source: 'typeform', formData: payload };

    for (const answer of answers) {
      const field = FIELD_MAP[answer.field?.ref];
      if (field) {
        data[field] = answer.email || answer.text || answer.choice?.label;
      }
    }

    if (!data.email) {
      for (const answer of answers) {
        if (answer.type === 'email') {
          data.email = answer.email;
          break;
        }
      }
    }

    // Also try to get phone from answers
    let phone = '';
    for (const answer of answers) {
      if (answer.type === 'phone_number') {
        phone = answer.phone_number;
        break;
      }
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

    console.log(`Lead created/updated: ${lead.id} (${lead.email})`);

    // Generate personalized email with AI
    const formSummary = extractFormSummary(answers);
    const emailContent = await generatePersonalizedEmail(
      lead.firstName || '',
      data.company || '',
      formSummary
    );

    // Send personalized email via Resend API
    try {
      await sendEmail(
        lead.email,
        emailContent.subject,
        `
        <div style="font-family: 'Helvetica Neue', Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #3B0764; color: #E8EAF6; padding: 40px; border-radius: 12px;">
          <h2 style="color: #ffffff; margin-bottom: 24px; font-weight: 600;">${emailContent.subject}</h2>
          <div style="font-size: 15px; line-height: 1.8; white-space: pre-line;">${emailContent.body}</div>
          <hr style="border: 1px solid #5B21B6; margin: 28px 0;" />
          <p style="font-size: 13px; color: #A78BFA; margin: 0;">Third Eye Consultancy \u2014 Let's see further together.</p>
        </div>
        `
      );
      console.log(`Email sent to ${lead.email}`);
    } catch (emailErr) {
      console.error('Failed to send email:', emailErr);
    }

    // Send SMS notification if phone provided
    if (phone) {
      try {
        await sendSMS(phone, `Hey ${lead.firstName || 'there'}! Third Eye Consultancy here. We got your intake form and a team member will reach out within 24-48 hours. Reply STOP to opt out.`);
      } catch (smsErr) {
        console.error('Failed to send SMS:', smsErr);
      }

      // Send WhatsApp notification
      try {
        await sendWhatsApp(phone, `Hey ${lead.firstName || 'there'}! \u{1F441} Third Eye Consultancy here. We received your submission and are reviewing it now. A team member will be in touch within 24-48 hours. Let's see further together.`);
      } catch (waErr) {
        console.error('Failed to send WhatsApp:', waErr);
      }
    }

    res.json({ success: true, leadId: lead.id });
  } catch (error) {
    console.error('Typeform webhook error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get all leads
app.get('/leads', async (req, res) => {
  try {
    const leads = await prisma.lead.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    res.json(leads);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch leads' });
  }
});

// Get campaigns
app.get('/campaigns', async (req, res) => {
  try {
    const campaigns = await prisma.campaign.findMany({
      include: { steps: true },
    });
    res.json(campaigns);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch campaigns' });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Crescendo backend running on port ${PORT}`);
});

export default app;
