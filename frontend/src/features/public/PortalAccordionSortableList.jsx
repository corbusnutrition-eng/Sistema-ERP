import { useMemo } from 'react'
import {
  DndContext,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'

function SortablePortalSection({ id, children }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`relative touch-manipulation ${isDragging ? 'z-50 opacity-90 drop-shadow-[0_18px_40px_rgba(0,0,0,0.55)]' : ''}`}
    >
      {typeof children === 'function'
        ? children({ dragHandleProps: { ...attributes, ...listeners }, isDragging })
        : children}
    </div>
  )
}

/**
 * Lista vertical reordenable de secciones del portal (acordeones).
 * El arrastre solo se activa desde el handle (⋮⋮) para no interferir con el scroll móvil.
 */
export default function PortalAccordionSortableList({ order, onOrderChange, sections }) {
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const visibleIds = useMemo(
    () => order.filter((id) => sections[id] != null),
    [order, sections],
  )

  function handleDragEnd(event) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = order.indexOf(active.id)
    const newIndex = order.indexOf(over.id)
    if (oldIndex < 0 || newIndex < 0) return
    onOrderChange(arrayMove(order, oldIndex, newIndex))
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={visibleIds} strategy={verticalListSortingStrategy}>
        {visibleIds.map((id) => (
          <SortablePortalSection key={id} id={id}>
            {({ dragHandleProps, isDragging }) =>
              sections[id]?.({ dragHandleProps, isDragging }) ?? null
            }
          </SortablePortalSection>
        ))}
      </SortableContext>
    </DndContext>
  )
}
