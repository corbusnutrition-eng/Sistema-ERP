import { Link } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import TagsManagerPanel from '../tags/TagsManagerPanel'

export default function TagsList() {
  return (
    <div className="max-w-3xl mx-auto space-y-6 pb-12 px-4">
      <div className="flex flex-wrap items-center gap-4 justify-between">
        <Link
          to="/listas"
          className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800"
        >
          <ArrowLeft size={16} />
          Volver a Listas
        </Link>
      </div>
      <TagsManagerPanel mode="embedded" className="min-h-[70vh]" />
    </div>
  )
}
