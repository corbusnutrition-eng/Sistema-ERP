from sqlalchemy import CheckConstraint, Column, Integer, String
from sqlalchemy.orm import relationship

from app.db.base import Base


class IPTVService(Base):
    __tablename__ = "iptv_services"
    __table_args__ = (
        CheckConstraint("available_screens >= 0 AND available_screens <= 3"),
    )

    id = Column(Integer, primary_key=True, index=True)
    provider = Column(String(50), nullable=False)  # Flujo/Stella
    account_name = Column(String(120), nullable=False, unique=True, index=True)
    available_screens = Column(Integer, nullable=False, default=3)

    subscriptions = relationship("Subscription", back_populates="service")
