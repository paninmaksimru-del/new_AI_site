import { ChevronRight } from 'lucide-react'
import { Button } from './ui/button'

const HERO_VIDEO =
  'https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260309_042944_4a2205b7-b061-490a-852b-92d9e9955ce9.mp4'

const brands = [
  'ChatGPT',
  'Claude',
  'DeepSeek',
  'Perplexity',
  'GigaChat',
  'YandexGPT',
  'Manus',
  'Gemini',
]

export default function HeroSection() {
  return (
    <section className="relative min-h-screen flex flex-col overflow-hidden">
      {/* Background video */}
      <video
        className="absolute inset-0 w-full h-full object-cover"
        autoPlay
        loop
        muted
        playsInline
      >
        <source src={HERO_VIDEO} type="video/mp4" />
      </video>

      {/* Gradient overlay */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            'linear-gradient(to bottom, transparent 0%, transparent 30%, hsl(260 87% 3% / 0.1) 45%, hsl(260 87% 3% / 0.4) 60%, hsl(260 87% 3% / 0.75) 75%, hsl(260 87% 3%) 95%)',
        }}
      />

      {/* Content */}
      <div className="relative z-10 flex flex-col flex-1 px-4">
        {/* Navbar */}
        <nav className="mx-auto w-full max-w-[850px] mt-6">
          <div className="liquid-glass rounded-3xl px-4 py-3 flex items-center justify-between gap-4">
            {/* Logo */}
            <a href="/" className="flex items-center gap-2 shrink-0">
              <div className="w-7 h-7 rounded-lg bg-gradient-to-b from-secondary to-muted flex items-center justify-center overflow-hidden">
                <img
                  src="/mik_logo_white.svg"
                  alt="МИК"
                  className="w-5 h-5 object-contain"
                  style={{ mixBlendMode: 'screen' }}
                />
              </div>
              <span className="text-xl font-semibold text-foreground">МИК</span>
            </a>

            {/* Nav links */}
            <div className="hidden md:flex items-center gap-1">
              <a
                href="/education"
                className="px-3 py-1.5 text-sm text-foreground/70 hover:text-foreground transition-colors rounded-xl hover:bg-white/5"
              >
                Обучение
              </a>
              <a
                href="/cases"
                className="px-3 py-1.5 text-sm text-foreground/70 hover:text-foreground transition-colors rounded-xl hover:bg-white/5"
              >
                Кейсы
              </a>
              <a
                href="/dashboard"
                className="px-3 py-1.5 text-sm text-foreground/70 hover:text-foreground transition-colors rounded-xl hover:bg-white/5"
              >
                Статистика
              </a>
              <a
                href="/cases#feedback"
                className="px-3 py-1.5 text-sm text-foreground/70 hover:text-foreground transition-colors rounded-xl hover:bg-white/5"
              >
                Обратная связь
              </a>
            </div>

            {/* CTA */}
            <Button variant="hero" size="sm" asChild>
              <a href="/profile">Личный кабинет</a>
            </Button>
          </div>
        </nav>

        {/* Hero content */}
        <div className="flex-1 flex flex-col items-center justify-center text-center pt-16 pb-8 max-w-5xl mx-auto w-full">
          {/* Badge */}
          <div className="liquid-glass rounded-full px-4 py-2 flex items-center gap-2 mb-8 text-sm">
            <span className="text-foreground/80">МИК v2.0 запущена!</span>
            <span className="liquid-glass rounded-full px-2.5 py-0.5 text-xs text-foreground/60 flex items-center gap-1">
              Открыть <ChevronRight className="w-3 h-3" />
            </span>
          </div>

          {/* Heading */}
          <h1 className="text-hero-heading text-4xl sm:text-6xl lg:text-7xl font-semibold leading-[1.05] tracking-tight max-w-5xl">
            Витрина ИИ&#8209;инструментов
            <br />
            для сотрудников Фонда МИК
          </h1>

          {/* Subheading */}
          <p className="text-hero-sub text-lg max-w-md mt-4 opacity-80">
            Пробуем и внедряем различные ИИ‑системы в повседневную работу
          </p>

          {/* CTA Buttons */}
          <div className="flex flex-wrap items-center justify-center gap-4 mt-8">
            <Button variant="hero" asChild>
              <a href="/education">Для новичков</a>
            </Button>
            <Button variant="heroSecondary" asChild>
              <a href="/cases">Для практиков</a>
            </Button>
          </div>
        </div>

        {/* Marquee */}
        <div className="pb-12 max-w-5xl mx-auto w-full overflow-hidden">
          <div
            className="flex gap-4 animate-marquee"
            style={{ width: 'max-content' }}
          >
            {[...brands, ...brands].map((brand, i) => (
              <div
                key={i}
                className="liquid-glass rounded-xl px-4 py-2 flex items-center gap-2 shrink-0"
              >
                <div className="w-6 h-6 rounded-lg bg-secondary flex items-center justify-center text-xs font-semibold text-foreground/70 shrink-0">
                  {brand[0]}
                </div>
                <span className="text-sm text-foreground/60 whitespace-nowrap">
                  {brand}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}
