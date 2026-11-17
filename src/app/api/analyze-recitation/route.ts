import { NextRequest } from 'next/server';
import { handleAnalyzeRecitationRequest } from '@/lib/cloudRecitationHandler';

export const runtime = 'nodejs';
export const maxDuration = 30;

export async function POST(req: NextRequest) {
  return handleAnalyzeRecitationRequest(req, false);
}
