import { Button } from './ui/button'
import HlsVideo from './HlsVideo'

const HLS_URL =
  'https://stream.mux.com/tLkHO1qZoaaQOUeVWo8hEBeGQfySP02EPS02BmnNFyXys.m3u8'

export default function CTAFooterWrapper() {
  return (
    <div className="relative overflow-hidden">
      {/* Background video */}
      <div className="absolute inset-0">
        <HlsVideo src={HLS_URL} />
      </div>

      {/* Gradient overlay */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            'linear-gradient(to bottom, hsl(260 87% 3%) 0%, hsl(260 87% 3% / 0.85) 15%, hsl(260 87% 3% / 0.4) 40%, hsl(260 87% 3% / 0.15) 60%, hsl(260 87% 3% / 0.3) 100%)',
        }}
      />

      {/* CTA Section */}
      <section className="relative z-10 py-32 px-4">
        <div className="max-w-4xl mx-auto">
          <div className="liquid-glass rounded-[2rem] p-12 sm:p-20 text-center">
            <h2 className="text-hero-heading text-3xl sm:text-5xl font-semibold leading-tight mb-6">
              Начните работать с ИИ
              <br />
              уже сегодня
            </h2>
            <p className="text-muted-foreground text-lg max-w-lg mx-auto mb-10">
              Присоединяйтесь к коллегам, которые уже используют ИИ в
              ежедневной работе. Всё доступно прямо сейчас.
            </p>
            <div className="flex flex-wrap items-center justify-center gap-4">
              <Button variant="hero" asChild>
                <a href="/education">Начать для новичков</a>
              </Button>
              <Button variant="heroSecondary" asChild>
                <a href="/cases#feedback">Написать нам</a>
              </Button>
            </div>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="relative z-10 border-t border-border/30 px-4 pt-16 pb-8">
        <div className="max-w-6xl mx-auto">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-8 mb-12">
            {/* Brand */}
            <div className="col-span-2 md:col-span-1">
              <a href="/" className="flex items-center gap-2 mb-4">
                <div className="w-7 h-7 rounded-lg bg-gradient-to-b from-secondary to-muted flex items-center justify-center overflow-hidden">
                  <img
                    src="/mik_logo_white.svg"
                    alt="МИК"
                    className="w-5 h-5 object-contain"
                    style={{ mixBlendMode: 'screen' }}
                  />
                </div>
                <span className="text-lg font-semibold text-foreground">МИК</span>
              </a>
              <p className="text-muted-foreground text-sm leading-relaxed">
                Платформа внедрения
                <br />
                ИИ-инструментов Фонда МИК
              </p>
            </div>

            {/* Platform */}
            <div>
              <p className="text-foreground/50 text-xs font-semibold uppercase tracking-wider mb-4">
                Платформа
              </p>
              <ul className="space-y-3">
                {[
                  { label: 'Материалы', href: '/education' },
                  { label: 'Кейсы', href: '/cases' },
                  { label: 'Промпты', href: '/cases' },
                  { label: 'Статистика', href: '/dashboard' },
                ].map((item) => (
                  <li key={item.label}>
                    <a
                      href={item.href}
                      className="text-muted-foreground text-sm hover:text-foreground transition-colors"
                    >
                      {item.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>

            {/* Account */}
            <div>
              <p className="text-foreground/50 text-xs font-semibold uppercase tracking-wider mb-4">
                Аккаунт
              </p>
              <ul className="space-y-3">
                {[
                  { label: 'Личный кабинет', href: '/profile' },
                  { label: 'Войти', href: '/login' },
                ].map((item) => (
                  <li key={item.label}>
                    <a
                      href={item.href}
                      className="text-muted-foreground text-sm hover:text-foreground transition-colors"
                    >
                      {item.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>

            {/* Contacts */}
            <div>
              <p className="text-foreground/50 text-xs font-semibold uppercase tracking-wider mb-4">
                Контакты
              </p>
              <ul className="space-y-3">
                {[
                  { label: 'Написать нам', href: '/cases#feedback' },
                  { label: 'Обратная связь', href: '/cases#feedback' },
                ].map((item) => (
                  <li key={item.label}>
                    <a
                      href={item.href}
                      className="text-muted-foreground text-sm hover:text-foreground transition-colors"
                    >
                      {item.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          {/* Bottom bar */}
          <div className="border-t border-border/30 pt-8 flex flex-wrap items-center justify-between gap-4">
            <span className="text-muted-foreground text-sm">
              © 2026 Фонд МИК. Внутренний ресурс для сотрудников.
            </span>
            <div className="flex gap-6">
              <a
                href="#"
                className="text-muted-foreground text-sm hover:text-foreground transition-colors"
              >
                Конфиденциальность
              </a>
              <a
                href="#"
                className="text-muted-foreground text-sm hover:text-foreground transition-colors"
              >
                Условия
              </a>
            </div>
          </div>
        </div>
      </footer>

    </div>
  )
}
