import { z } from 'zod'

export const agentSubjectSchema = z.uuidv7()
export const agentAddressSchema = z.templateLiteral(['agent:', agentSubjectSchema])
