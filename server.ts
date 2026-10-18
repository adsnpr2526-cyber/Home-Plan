import express, { Request, Response } from 'express';
import { GoogleGenAI, Type } from '@google/genai';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

// High limit for base64 sketches and photos
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY || '',
  httpOptions: {
    headers: {
      'User-Agent': 'aistudio-build',
    },
  },
});

// JSON Schema definition for architectural floor plan output
const FloorPlanSchema = {
  type: Type.OBJECT,
  properties: {
    metadata: {
      type: Type.OBJECT,
      properties: {
        title: { type: Type.STRING, description: 'Project title in Thai and English' },
        projectNumber: { type: Type.STRING },
        clientName: { type: Type.STRING },
        architect: { type: Type.STRING },
        date: { type: Type.STRING },
        scale: { type: Type.STRING, description: 'e.g. 1:100 or 1:75' },
        northAngle: { type: Type.NUMBER, description: 'Degrees (0 = Up, 90 = Right)' },
        totalAreaSqM: { type: Type.NUMBER },
        estimatedCostMinTHB: { type: Type.NUMBER },
        estimatedCostMaxTHB: { type: Type.NUMBER },
      },
      required: ['title', 'scale', 'totalAreaSqM'],
    },
    dimensions: {
      type: Type.OBJECT,
      properties: {
        totalWidth: { type: Type.NUMBER, description: 'Total building width in meters' },
        totalHeight: { type: Type.NUMBER, description: 'Total building depth/height in meters' },
      },
      required: ['totalWidth', 'totalHeight'],
    },
    rooms: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING },
          name: { type: Type.STRING, description: 'English name, e.g. Master Bedroom' },
          nameTh: { type: Type.STRING, description: 'Thai name, e.g. ห้องนอนใหญ่' },
          type: {
            type: Type.STRING,
            description: 'bedroom, living, kitchen, bathroom, dining, balcony, hallway, garage, office, storage, terrace, utility',
          },
          bounds: {
            type: Type.OBJECT,
            properties: {
              x: { type: Type.NUMBER, description: 'X coordinate in meters from origin (0 to totalWidth)' },
              y: { type: Type.NUMBER, description: 'Y coordinate in meters from origin (0 to totalHeight)' },
              width: { type: Type.NUMBER, description: 'Width in meters' },
              height: { type: Type.NUMBER, description: 'Height/depth in meters' },
            },
            required: ['x', 'y', 'width', 'height'],
          },
          areaSqM: { type: Type.NUMBER },
          floorFinish: { type: Type.STRING, description: 'Floor material description in Thai' },
          color: { type: Type.STRING, description: 'Hex color or CSS tint for presentation' },
        },
        required: ['id', 'name', 'nameTh', 'type', 'bounds', 'areaSqM'],
      },
    },
    walls: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING },
          start: {
            type: Type.OBJECT,
            properties: { x: { type: Type.NUMBER }, y: { type: Type.NUMBER } },
            required: ['x', 'y'],
          },
          end: {
            type: Type.OBJECT,
            properties: { x: { type: Type.NUMBER }, y: { type: Type.NUMBER } },
            required: ['x', 'y'],
          },
          thickness: { type: Type.NUMBER, description: '0.15 for exterior walls, 0.10 for interior partition walls' },
          isExterior: { type: Type.BOOLEAN },
        },
        required: ['id', 'start', 'end', 'thickness', 'isExterior'],
      },
    },
    doors: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING },
          position: {
            type: Type.OBJECT,
            properties: { x: { type: Type.NUMBER }, y: { type: Type.NUMBER } },
            required: ['x', 'y'],
          },
          rotation: { type: Type.NUMBER, description: 'Angle in degrees: 0 (facing right), 90 (facing down), 180 (facing left), 270 (facing up)' },
          width: { type: Type.NUMBER, description: 'Door width in meters, usually 0.8 to 1.6' },
          type: { type: Type.STRING, description: 'single, double, sliding, or opening' },
          swingDirection: { type: Type.STRING, description: 'left, right, inward, outward' },
          label: { type: Type.STRING, description: 'e.g. D1, D2' },
        },
        required: ['id', 'position', 'rotation', 'width', 'type'],
      },
    },
    windows: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING },
          position: {
            type: Type.OBJECT,
            properties: { x: { type: Type.NUMBER }, y: { type: Type.NUMBER } },
            required: ['x', 'y'],
          },
          rotation: { type: Type.NUMBER, description: '0, 90, 180, or 270' },
          width: { type: Type.NUMBER, description: 'Window width in meters, usually 1.0 to 2.4' },
          type: { type: Type.STRING, description: 'sliding, casement, fixed' },
          label: { type: Type.STRING, description: 'e.g. W1, W2' },
        },
        required: ['id', 'position', 'rotation', 'width', 'type'],
      },
    },
    furniture: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING },
          type: { type: Type.STRING, description: 'bed_king, bed_single, sofa_3seat, dining_4, kitchen_counter, sink, stove, toilet, shower, bathtub, washbasin, wardrobe, tv_stand, car' },
          name: { type: Type.STRING },
          nameTh: { type: Type.STRING },
          position: {
            type: Type.OBJECT,
            properties: { x: { type: Type.NUMBER }, y: { type: Type.NUMBER } },
            required: ['x', 'y'],
          },
          rotation: { type: Type.NUMBER },
          width: { type: Type.NUMBER },
          length: { type: Type.NUMBER },
        },
        required: ['id', 'type', 'name', 'nameTh', 'position', 'rotation', 'width', 'length'],
      },
    },
    dimensionLines: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING },
          start: {
            type: Type.OBJECT,
            properties: { x: { type: Type.NUMBER }, y: { type: Type.NUMBER } },
            required: ['x', 'y'],
          },
          end: {
            type: Type.OBJECT,
            properties: { x: { type: Type.NUMBER }, y: { type: Type.NUMBER } },
            required: ['x', 'y'],
          },
          offset: { type: Type.NUMBER },
          label: { type: Type.STRING },
          axis: { type: Type.STRING, description: 'x or y' },
        },
        required: ['id', 'start', 'end', 'offset', 'label', 'axis'],
      },
    },
    constructionNotes: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
    },
  },
  required: ['metadata', 'dimensions', 'rooms', 'walls', 'doors', 'windows', 'furniture', 'dimensionLines', 'constructionNotes'],
};

// API Endpoint to parse sketch with Gemini Vision
app.post('/api/parse-sketch', async (req: Request, res: Response) => {
  try {
    const { imageBase64, mimeType = 'image/png', additionalInstructions = '', presetStyle = 'modern' } = req.body;

    if (!imageBase64) {
      return res.status(400).json({ error: 'Missing imageBase64 data in request body' });
    }

    // Strip data URL header if present
    const cleanBase64 = imageBase64.replace(/^data:image\/[a-zA-Z+]+;base64,/, '');

    const systemInstruction = `You are a licensed Senior Architect and Building CAD Expert (สถาปนิกและผู้เชี่ยวชาญการเขียนแบบแปลนสถาปัตยกรรมระดับมืออาชีพ).
Your mission is to analyze a hand-drawn floor plan sketch (ภาพสเก็ตช์ลายเส้นวาดด้วยมือ) and transcribe it into a clean, complete, architecturally sound 2D CAD floor plan.

ARCHITECTURAL PRINCIPLES TO FOLLOW:
1. Orthogonal Correction: Straighten uneven hand-drawn lines into clean right-angle (90-degree) walls aligning to a sensible meter grid (0.1m or 0.5m grid snaps).
2. Space Planning & Rooms:
   - Identify every room enclosed by the sketch (Living room / ห้องนั่งเล่น, Bedrooms / ห้องนอน, Bathrooms / ห้องน้ำ, Kitchen / ห้องครัว, Dining / ส่วนรับประทานอาหาร, Balcony / ระเบียง, Foyer / โถงทางเข้า, Carport / ที่จอดรถ).
   - Ensure room bounds are non-overlapping and contiguous (x, y, width, height in meters).
   - Compute exact room area in square meters.
   - Assign appropriate architectural floor finishes in Thai (e.g. กระเบื้องแกรนิตโต้ 60x60 ซม., ไม้ลามิเนตลายธรรมชาติ หนา 8 มม., กระเบื้องเซรามิกกันลื่น R10 สำหรับห้องน้ำ, ปูนขัดมัน).
3. Wall Construction:
   - Generate perimeter exterior walls with thickness 0.15m (ผนังภายนอกก่ออิฐฉาบปูน 2 ด้าน).
   - Generate interior partition walls with thickness 0.10m (ผนังกั้นห้อง).
   - Ensure wall endpoints meet at common corners so the building perimeter is closed.
4. Doors & Openings:
   - Position doors along walls where the sketch indicates doorways, gaps, or swing arcs.
   - Standard door dimensions:
     * Entrance / Main door: 1.0m to 1.6m (single or sliding)
     * Bedroom doors: 0.8m or 0.9m
     * Bathroom doors: 0.7m or 0.8m
     * Balcony / Patio: 1.4m to 2.4m sliding door
   - Provide correct orientation (0=Right, 90=Down, 180=Left, 270=Up) and swing direction so doors open inwards against adjacent walls without colliding.
5. Windows:
   - Place windows along exterior walls to provide natural light and cross-ventilation to each room.
   - Bedrooms: 1.2m to 2.0m sliding/casement window.
   - Living room: 2.0m to 3.0m wide window or glass door.
   - Bathroom: 0.6m to 0.8m high vent/casement window.
   - Kitchen: 1.0m to 1.5m window over sink/counter.
6. Standard Furniture & Sanity Fixtures:
   - Furnish the spaces realistically:
     * Master Bedroom: King-size bed (2.0x2.0m), side tables, wardrobe (0.6x2.0m).
     * Secondary Bedroom: Queen/Single bed, wardrobe, desk.
     * Living Room: 3-seater or L-shape sofa, coffee table, TV console.
     * Kitchen: L-shape or straight counter (width 0.6m) with kitchen sink and induction stove.
     * Bathroom: Water closet/toilet (0.7x0.45m), washbasin with vanity (0.6x0.5m), shower enclosure (0.9x0.9m).
     * Dining: Dining table with 4-6 chairs.
7. Dimension Lines:
   - Add CAD dimension strings along the outer top/left/right/bottom edges showing room spans (e.g. 3.50 m, 4.00 m, 2.00 m) and overall building dimensions.
8. Thai Building Standards:
   - Provide construction notes in professional Thai architectural phrasing.
   - Estimate rough construction costs in THB based on current Thai construction rates (approx. 13,000 - 18,000 THB/sq.m. for residential standard).`;

    const promptText = `Analyze this hand-drawn architectural sketch image in detail.
Transcribe and resolve every sketched room, wall line, door, window, and fixture into an orthogonal, perfectly aligned, complete architectural floor plan JSON.
Additional user preferences: ${additionalInstructions || 'Standard comfortable residential layout, modern minimalist CAD standard.'}
Selected style context: ${presetStyle}.
Ensure coordinates and bounds are completely aligned, clean, and in meters.`;

    const response = await ai.models.generateContent({
      model: 'gemini-3.8-flash',
      contents: [
        {
          role: 'user',
          parts: [
            {
              inlineData: {
                data: cleanBase64,
                mimeType: mimeType,
              },
            },
            {
              text: promptText,
            },
          ],
        },
      ],
      config: {
        systemInstruction,
        responseMimeType: 'application/json',
        responseSchema: FloorPlanSchema,
        temperature: 0.2, // Low temperature for high architectural precision
      },
    });

    const responseText = response.text;
    if (!responseText) {
      throw new Error('Gemini model did not return any text output');
    }

    const planData = JSON.parse(responseText);

    // Sanity checks and defaults
    if (!planData.metadata) {
      planData.metadata = {
        title: 'แบบแปลนบ้านพักอาศัย (Transcribed Floor Plan)',
        scale: '1:100',
        totalAreaSqM: 85,
        northAngle: 0,
      };
    }

    return res.json({
      success: true,
      floorPlan: planData,
    });
  } catch (err: unknown) {
    console.error('Error in /api/parse-sketch:', err);
    const errorMessage = err instanceof Error ? err.message : 'Unknown error during sketch parsing';
    return res.status(500).json({
      success: false,
      error: errorMessage,
    });
  }
});

// Vite middleware in dev or static files in production
async function startServer() {
  const isProd = process.env.NODE_ENV === 'production';

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    if (fs.existsSync(distPath)) {
      app.use(express.static(distPath));
      app.get('*', (_req: Request, res: Response) => {
        res.sendFile(path.resolve(distPath, 'index.html'));
      });
    }
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`PlanDraft AI Server running on http://localhost:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
});
