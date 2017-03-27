from django.db import models
from django.utils import timezone
from django.core.files.storage import FileSystemStorage

from django.contrib.auth.models import (
    BaseUserManager, AbstractBaseUser
)

media_folder = FileSystemStorage(location='/media/images')
# Site Info
class Maatic(models.Model):
    site_name = models.CharField(max_length=100)
    tagline = models.TextField(max_length=200)
    keywords = models.TextField(max_length=500)

    def __str__(self):
        return self.name
# Library
class Library(models.Model):
    name = models.CharField(max_length=255)
    tagline = models.TextField(max_length=500)

    def __str__(self):
        return self.name
# Author of book
class Author(models.Model):
    name = models.CharField(max_length=255)
    email = models.EmailField()
    bio = models.TextField()

    def __str__(self):
        return self.name
# Subjects of a book 
class Subject(models.Model):
    subject = models.CharField(max_length=255, db_index=True)
    slug = models.SlugField(max_length=255, db_index=True)

    def __str__(self):
        return self.subject
# Chapters of book
class Chapter(models.Model):
    title = models.CharField(max_length=255, db_index=True)
    slug = models.SlugField(max_length=255, db_index=True)
    info = models.TextField()

    def __str__(self):           
        return self.book_name
# Book
class Book(models.Model):
    subject = models.ManyToManyField(Subject)
    chapter = models.ManyToManyField(Chapter)
    book_name = models.CharField(max_length=255, db_index=True)
    slug = models.SlugField(max_length=255, db_index=True)
    introduction = models.TextField()
    publication_date = models.DateField()
    modified_date = models.DateField()
    authors = models.ManyToManyField(Author)
    comment_feature = models.IntegerField()
    pingbacks = models.IntegerField()
    rating = models.IntegerField()
    image = models.ImageField(storage=media_folder)

    def __str__(self):           
        return self.book_name
# Leaf are pages of a book
class Leaf(models.Model):
    book = models.ForeignKey(Book)
    chapter = models.ForeignKey(Chapter)
    headline = models.CharField(max_length=255)
    body_text = models.TextField()
    posted_date = models.DateField()
    mod_date = models.DateField()

    def __str__(self):
        return self.headline
# Comments
class Comment(models.Model):
    book = models.ForeignKey(Book, related_name='comments')
    author = models.CharField(max_length=200)
    comment = models.TextField()
    created_date = models.DateTimeField(default=timezone.now)
    approved_comment = models.BooleanField(default=False)

    def approve(self):
        self.approved_comment = True
        self.save()

    def __str__(self):
        return self.text
    
    
    ################### User Model ####################

class MyUserManager(BaseUserManager):
    def create_user(self, email, date_of_birth, password=None):
        """
        Creates and saves a User with the given email, date of
        birth and password.
        """
        if not email:
            raise ValueError('Users must have an email address')

        user = self.model(
            email=self.normalize_email(email),
            date_of_birth=date_of_birth,
        )

        user.set_password(password)
        user.save(using=self._db)
        return user

    def create_superuser(self, email, date_of_birth, password):
        """
        Creates and saves a superuser with the given email, date of
        birth and password.
        """
        user = self.create_user(
            email,
            password=password,
            date_of_birth=date_of_birth,
        )
        user.is_admin = True
        user.save(using=self._db)
        return user


class User(AbstractBaseUser):
    email = models.EmailField(
        verbose_name='email address',
        max_length=255,
        unique=True,
    )
    date_of_birth = models.DateField()
    is_active = models.BooleanField(default=True)
    is_admin = models.BooleanField(default=False)

    objects = MyUserManager()

    USERNAME_FIELD = 'email'
    REQUIRED_FIELDS = ['date_of_birth']

    def get_full_name(self):
        # The user is identified by their email address
        return self.email

    def get_short_name(self):
        # The user is identified by their email address
        return self.email

    def __str__(self):              # __unicode__ on Python 2
        return self.email

    def has_perm(self, perm, obj=None):
        "Does the user have a specific permission?"
        # Simplest possible answer: Yes, always
        return True

    def has_module_perms(self, app_label):
        "Does the user have permissions to view the app `app_label`?"
        # Simplest possible answer: Yes, always
        return True

    @property
    def is_staff(self):
        "Is the user a member of staff?"
        # Simplest possible answer: All admins are staff
        return self.is_admin