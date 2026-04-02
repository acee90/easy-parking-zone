import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// jsdom doesn't implement scrollIntoView
Element.prototype.scrollIntoView = () => {}

afterEach(() => {
  cleanup()
})
