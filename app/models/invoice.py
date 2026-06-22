from sqlalchemy import Column, DateTime, Float, Integer, String, func

from app.db.base import Base


class Invoice(Base):
    __tablename__ = "invoices"

    id = Column(Integer, primary_key=True, index=True)
    customer_name = Column(String(120), nullable=False, index=True)
    amount = Column(Float, nullable=False)
    status = Column(String(30), nullable=False, default="pending")
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
