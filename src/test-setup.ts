import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

// jsdom doesn't implement scrollIntoView
Element.prototype.scrollIntoView = () => {}

afterEach(() => {
  cleanup()
})
