import HeroSection from './components/HeroSection'
import FeaturesSection from './components/FeaturesSection'
import ChessSection from './components/ChessSection'
import ReverseChessSection from './components/ReverseChessSection'
import NumbersSection from './components/NumbersSection'
import TestimonialsSection from './components/TestimonialsSection'
import CTAFooterWrapper from './components/CTAFooterWrapper'

export default function App() {
  return (
    <div className="bg-background text-foreground min-h-screen">
      <HeroSection />
      <FeaturesSection />
      <ChessSection />
      <ReverseChessSection />
      <NumbersSection />
      <TestimonialsSection />
      <CTAFooterWrapper />
    </div>
  )
}
