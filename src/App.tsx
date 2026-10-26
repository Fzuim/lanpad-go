import { useEffect, useState } from 'react'
import Home from './components/Home'
import DocPage from './components/DocPage'

function routeFromLocation(): string {
  return window.location.pathname
}

export default function App() {
  const [route, setRoute] = useState(routeFromLocation)

  useEffect(() => {
    const onPopState = () => setRoute(routeFromLocation())
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  function navigate(path: string) {
    if (window.location.pathname === path) return
    window.history.pushState({}, '', path)
    setRoute(path)
    window.scrollTo({ top: 0 })
  }

  const match = route.match(/^\/d\/([0-9a-z]{12})$/)
  if (match) {
    return <DocPage key={match[1]} docId={match[1]} onBack={() => navigate('/')} />
  }

  return <Home onOpen={(id) => navigate(`/d/${id}`)} />
}
