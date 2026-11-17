import { NextRequest, NextResponse } from 'next/server';

const ALLOWED_AUDIO_HOSTS = new Set([
  'everyayah.com',
  'www.everyayah.com',
  'audio.qurancdn.com',
  'verses.quran.com',
]);

export async function GET(request: NextRequest) {
  const targetUrl = request.nextUrl.searchParams.get('url');
  if (!targetUrl) {
    return NextResponse.json(
      { error: 'Параметр ?url= обязателен' },
      { status: 400 }
    );
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(targetUrl);
  } catch {
    return NextResponse.json(
      { error: 'Некорректный формат URL' },
      { status: 400 }
    );
  }

  if (
    parsedUrl.protocol !== 'https:' ||
    !ALLOWED_AUDIO_HOSTS.has(parsedUrl.hostname)
  ) {
    return NextResponse.json(
      { error: 'Домен не входит в белый список аудио-источников Корана' },
      { status: 403 }
    );
  }

  try {
    const upstreamResponse = await fetch(parsedUrl.toString(), {
      headers: {
        'User-Agent': 'Tajweed-DSP-Trainer/1.0',
      },
      cache: 'force-cache',
    });

    if (!upstreamResponse.ok) {
      return NextResponse.json(
        { error: `Ошибка загрузки эталонного аудио: ${upstreamResponse.status}` },
        { status: upstreamResponse.status }
      );
    }

    const arrayBuffer = await upstreamResponse.arrayBuffer();

    return new NextResponse(arrayBuffer, {
      status: 200,
      headers: {
        'Content-Type':
          upstreamResponse.headers.get('Content-Type') || 'audio/mpeg',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Сбой проксирования аудио';
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
