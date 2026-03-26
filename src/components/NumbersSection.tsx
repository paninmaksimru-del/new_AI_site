import HlsVideo from './HlsVideo'

const HLS_URL =
  'https://stream.mux.com/Kec29dVyJgiPdtWaQtPuEiiGHkJIYQAVUJcNiIHUYeo.m3u8'

export default function NumbersSection() {
  return (
    <section className="relative py-32 px-4 overflow-hidden">
      {/* Background video */}
      <div className="absolute inset-0">
        <HlsVideo src={HLS_URL} />
      </div>

      {/* Gradient overlay */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            'linear-gradient(to top, hsl(260 87% 3%) 0%, hsl(260 87% 3% / 0.85) 15%, hsl(260 87% 3% / 0.4) 40%, hsl(260 87% 3% / 0.15) 60%, hsl(260 87% 3% / 0.3) 100%)',
        }}
      />

      {/* Content */}
      <div className="relative z-10 max-w-5xl mx-auto text-center">
        {/* Hero metric */}
        <div className="mb-24">
          <p
            className="font-semibold tracking-tighter text-hero-heading leading-none"
            style={{ fontSize: 'clamp(5rem, 15vw, 10rem)' }}
          >
            9 сервисов
          </p>
          <p className="text-hero-heading text-xl sm:text-2xl mt-4 font-medium">
            Доступных ИИ-инструментов
          </p>
          <p className="text-muted-foreground mt-2">
            В контуре МИК и в публичном доступе
          </p>
        </div>

        {/* Bottom metrics */}
        <div className="liquid-glass rounded-3xl p-8 sm:p-12 grid md:grid-cols-2 gap-8">
          <div>
            <p className="text-hero-heading text-5xl sm:text-6xl font-semibold tracking-tight">
              20+
            </p>
            <p className="text-hero-heading text-lg mt-2 font-medium">
              Промптов
            </p>
            <p className="text-muted-foreground mt-1">Готовых шаблонов задач</p>
          </div>
          <div className="md:border-l border-t md:border-t-0 border-border/50 md:pl-8 pt-8 md:pt-0">
            <p className="text-hero-heading text-5xl sm:text-6xl font-semibold tracking-tight">
              4 раздела
            </p>
            <p className="text-hero-heading text-lg mt-2 font-medium">
              На платформе
            </p>
            <p className="text-muted-foreground mt-1">
              Нейросети, промпты, кейсы, материалы
            </p>
          </div>
        </div>
      </div>
    </section>
  )
}
