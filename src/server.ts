import express from 'express';
import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const prisma = new PrismaClient();
const PORT = process.env.PORT || 3000;

app.use(express.json());

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

    // Extract fields from Typeform response
    const FIELD_MAP: Record<string, string> = {
      // Map your Typeform question ref IDs here
      // 'email_field_ref': 'email',
      // 'name_field_ref': 'firstName',
    };

    const data: any = { source: 'typeform', formData: payload };
    for (const answer of answers) {
      const field = FIELD_MAP[answer.field?.ref];
      if (field) {
        data[field] = answer.email || answer.text || answer.choice?.label;
      }
    }

    if (!data.email) {
      // Try to find email in answers
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
