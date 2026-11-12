import * as dotenv from 'dotenv'
dotenv.config()
import { PORT } from './config'
import { app } from './app'

const port = PORT
app.listen(port, () => console.log(`server started on http://localhost:${port}`))