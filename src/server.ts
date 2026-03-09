import express from 'express';
import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';
import nodemailer from 'nodemailer';

dotenv.config();

const app = express();
const prisma = new PrismaClient();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Email transporter
const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST,
  port: Number(process.env.EMAIL_PORT) || 587,
  secure: false,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

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

    if (!data.email) {
      return res.status(400).json({ error: 'No email found in submission' });
    }

    // Upsert lead
    const lead = await prisma.lead.upsert({
      where: { email: data.email },
      update: { formData: data.formData },
      create: data,
    });

    console.log(`Lead created/updated: ${lead.id} (${lead.email})`);

    // Send confirmation email
    try {
      await transporter.sendMail({
        from: `"Third Eye Consultancy" <${process.env.EMAIL_FROM}>`,
        to: lead.email,
        subject: 'We see you — Third Eye Consultancy',
        html: `
          <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; background: #3B0764; color: #E8EAF6; padding: 40px; border-radius: 12px;">
            <h1 style="color: #ffffff;">Welcome, ${lead.firstName || 'there'}.</h1>
            <p style="font-size: 16px; line-height: 1.6;">Thank you for reaching out to Third Eye Consultancy. We received your intake form and a member of our team will be in touch within 24–48 hours.</p>
            <p style="font-size: 16px; line-height: 1.6;">In the meantime, feel free to reply to this email with any additional details about your project.</p>
            <hr style="border: 1px solid #5B21B6; margin: 24px 0;" />
            <p style="font-size: 14px; color: #A78BFA;">Third Eye Consultancy — Let's see further together.</p>
          </div>
        `,
      });
      console.log(`Confirmation email sent to ${lead.email}`);
    } catch (emailErr) {
      console.error('Failed to send confirmation email:', emailErr);
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
