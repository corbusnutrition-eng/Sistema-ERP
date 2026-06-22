from sqlalchemy import Column, Enum, Integer, String
from sqlalchemy.orm import relationship

from app.db.base import Base


class Client(Base):
    __tablename__ = "clients"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(120), nullable=False)
    email = Column(String(255), nullable=False, unique=True, index=True)
    tax_id = Column(String(50), nullable=False, unique=True, index=True)
    client_type = Column(
        Enum("final", "reseller", name="client_type_enum"),
        nullable=False,
        default="final",
    )

    subscriptions = relationship("Subscription", back_populates="client")
    transactions = relationship("Transaction", back_populates="client")
